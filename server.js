'use strict';

const config = require('./config/env'); // validates env and exits early if misconfigured

const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Server } = require('socket.io');

const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/auth');
const questionRoutes = require('./routes/questionRoutes');
const examRoutes = require('./routes/examRoutes');
const aiCheckRoutes = require('./routes/aiCheckRoutes');
const Class = require('./models/Class');
const { verifyToken, resolveUser } = require('./middleware/auth');
const { sanitizeRequest } = require('./middleware/sanitize');
const { authLimiter, apiLimiter, judgeLimiterIfJudgePath, closeRateLimitStore } = require('./middleware/rateLimit');
const { cleanupStaleJudgeArtifacts, dockerHealthy, getJudgeQueueStats } = require('./utils/judge');
const { getJudgeMode, getRemoteQueueStats, closeJudgeRemote, setJudgeRemoteLogger } = require('./utils/judgeRemote');

const logger = pino({
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'], censor: '[redacted]' },
});

// In production, debug-level console.log noise (hundreds of call sites) is dropped; warn/error stay.
if (config.isProd && config.logLevel !== 'debug') {
    console.log = () => {};
    console.debug = () => {};
}

setJudgeRemoteLogger(logger);

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const corsOrigins = config.corsOrigins;
const corsOptions = {
    origin(origin, callback) {
        // Allow non-browser clients (no Origin) and configured frontends. Never throw: a thrown
        // CORS error becomes a 500 without ACAO headers.
        if (!origin || corsOrigins.includes(origin)) return callback(null, true);
        logger.warn({ origin }, 'CORS blocked origin');
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Safe Exam Browser adds its key hashes to every request; list them so CORS preflights pass.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-SafeExamBrowser-ConfigKeyHash', 'X-SafeExamBrowser-RequestHash'],
    exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After'],
    optionsSuccessStatus: 204,
    maxAge: 600,
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
    helmet({
        // API serves JSON plus a few images consumed by the React origin.
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: false,
    })
);
app.use(compression());
app.use(cors(corsOptions));
app.use(
    pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/health/live' },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: {
            req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
            res: (res) => ({ statusCode: res.statusCode }),
        },
    })
);
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));
app.use(sanitizeRequest);
app.use(apiLimiter);
app.use(judgeLimiterIfJudgePath);

// Only the two image folders are public; spreadsheets and judge files never live here.
const staticOpts = {
    index: false,
    dotfiles: 'deny',
    maxAge: '7d',
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    },
};
app.use('/uploads/avatars', express.static(path.join(__dirname, 'uploads', 'avatars'), staticOpts));
app.use('/uploads/questions', express.static(path.join(__dirname, 'uploads', 'questions'), staticOpts));

// ---------------------------------------------------------------------------
// Socket.IO (authenticated; class rooms require membership)
// ---------------------------------------------------------------------------
const io = new Server(server, {
    cors: { origin: corsOrigins, credentials: true, methods: ['GET', 'POST'] },
    pingTimeout: 30_000,
    maxHttpBufferSize: 64 * 1024,
});

io.use(async (socket, next) => {
    try {
        const raw =
            socket.handshake.auth?.token ||
            (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '') ||
            null;
        const decoded = verifyToken(raw);
        if (!decoded) return next(new Error('unauthorized'));
        const user = await resolveUser(decoded);
        if (!user) return next(new Error('unauthorized'));
        socket.data.user = { id: String(user._id), role: user.role };
        next();
    } catch (err) {
        next(new Error('unauthorized'));
    }
});

const OBJECT_ID = /^[a-f\d]{24}$/i;
const canJoinClassRoom = async (user, classId) => {
    if (!OBJECT_ID.test(String(classId))) return false;
    if (user.role === 'admin' || user.role === 'superAdmin') return Boolean(await Class.exists({ _id: classId }));
    const query =
        user.role === 'teacher'
            ? { _id: classId, $or: [{ teachers: user.id }, { createdBy: user.id }] }
            : { _id: classId, students: user.id };
    return Boolean(await Class.exists(query));
};

io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    socket.on('joinClass', async (classId, ack) => {
        try {
            const ok = await canJoinClassRoom(user, classId);
            if (!ok) {
                if (typeof ack === 'function') ack({ ok: false, error: 'Not a member of this class' });
                return;
            }
            socket.join(`class:${classId}`);
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
            logger.warn({ err: err.message }, 'joinClass failed');
            if (typeof ack === 'function') ack({ ok: false, error: 'Failed to join' });
        }
    });

    socket.on('leaveClass', (classId) => {
        if (OBJECT_ID.test(String(classId))) socket.leave(`class:${classId}`);
    });
});

// Optional Redis adapter so broadcasts work across PM2 cluster workers / several instances.
const adapterClients = [];
const setupRedisAdapter = async () => {
    if (!config.redisUrl) return;
    const { createAdapter } = require('@socket.io/redis-adapter');
    const Redis = require('ioredis');
    const pub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    const sub = pub.duplicate();
    adapterClients.push(pub, sub);
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    logger.info('Socket.IO Redis adapter enabled');
};

// Controllers emit through req.io
app.use((req, _res, next) => {
    req.io = io;
    next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', async (_req, res) => {
    const mongoUp = mongoose.connection.readyState === 1;
    const queueMode = getJudgeMode() === 'queue';
    const [dockerUp, judgeQueue] = await Promise.all([dockerHealthy(), queueMode ? getRemoteQueueStats() : null]);
    // In queue mode containers run on the worker hosts: the API host needs Redis + at least one
    // worker instead of a local Docker daemon. workers === null means Redis cannot list clients.
    const judgeUp = queueMode ? judgeQueue.redis === 'up' && judgeQueue.workers !== 0 : dockerUp;
    const status = mongoUp && judgeUp ? 'ok' : 'degraded';
    res.status(mongoUp ? 200 : 503).json({
        status,
        uptimeSeconds: Math.round(process.uptime()),
        mongo: mongoUp ? 'up' : 'down',
        docker: dockerUp ? 'up' : queueMode ? 'not-required' : 'down',
        judgeMode: queueMode ? 'queue' : 'local',
        judge: getJudgeQueueStats(),
        ...(queueMode ? { judgeQueue } : {}),
        version: process.env.APP_VERSION || null,
    });
});

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/questions', questionRoutes);
app.use('/exams', examRoutes);
app.use('/ai-check', aiCheckRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Keep CORS headers on errors (nginx should also add them with `always` for 502/504).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    if (res.headersSent) return;
    const status = Number(err.status) || Number(err.statusCode) || 500;
    if (status >= 500) {
        (req.log || logger).error({ err }, 'Unhandled error');
        return res.status(500).json({ error: 'Server error' });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    res.status(status).json({ error: err.message || 'Request failed' });
});

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;
const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(code || 1), 15_000).unref();
    try {
        await new Promise((resolve) => server.close(resolve));
        io.close();
        await Promise.allSettled([
            mongoose.disconnect(),
            closeJudgeRemote(),
            closeRateLimitStore(),
            ...adapterClients.map((c) => c.quit()),
        ]);
    } catch (err) {
        logger.error({ err }, 'Error during shutdown');
    } finally {
        clearTimeout(force);
        process.exit(code);
    }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; exiting so the process manager can restart');
    shutdown('uncaughtException', 1);
});

const start = async () => {
    try {
        mongoose.set('strictQuery', true);
        await mongoose.connect(config.mongoUri, {
            maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 20,
            serverSelectionTimeoutMS: 10_000,
            socketTimeoutMS: 45_000,
        });
        logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
        mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
        mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

        if (process.env.SYNC_INDEXES === '1') {
            await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
            logger.info('Indexes synced');
        }

        await setupRedisAdapter();
        if (getJudgeMode() === 'queue') {
            // This process never starts containers; connect to the queue early so problems show at boot.
            const q = await getRemoteQueueStats();
            if (q.redis === 'up') logger.info({ workers: q.workers, waiting: q.waiting }, 'Judge mode: queue (BullMQ)');
            else logger.warn({ error: q.error }, 'Judge mode: queue, but the judge queue is not reachable yet');
        } else {
            await cleanupStaleJudgeArtifacts();
        }

        server.timeout = 180_000;
        server.requestTimeout = 180_000;
        server.headersTimeout = 185_000;
        server.keepAliveTimeout = 65_000;
        server.listen(config.port, () => {
            logger.info({ port: config.port, env: config.nodeEnv, cors: corsOrigins }, 'Server started');
        });
    } catch (err) {
        logger.fatal({ err }, 'Startup failed');
        process.exit(1);
    }
};

if (require.main === module) start();

module.exports = { app, server, io, start };
