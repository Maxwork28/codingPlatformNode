const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

function env(name) {
  return String(process.env[name] || '').trim();
}

function isS3Enabled() {
  return Boolean(env('AWS_S3_BUCKET'));
}

let cachedClient;

function getS3Client() {
  if (cachedClient) return cachedClient;
  const region = env('AWS_REGION') || 'ap-south-1';
  const config = { region };
  const accessKeyId = env('AWS_ACCESS_KEY_ID');
  const secretAccessKey = env('AWS_SECRET_ACCESS_KEY');
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  cachedClient = new S3Client(config);
  return cachedClient;
}

function publicUrlForKey(key) {
  const base = env('AWS_S3_PUBLIC_BASE_URL').replace(/\/$/, '');
  if (base) return `${base}/${key}`;
  const bucket = env('AWS_S3_BUCKET');
  const region = env('AWS_REGION') || 'ap-south-1';
  if (!region || region === 'us-east-1') {
    return `https://${bucket}.s3.amazonaws.com/${encodeURI(key)}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;
}

function questionImageKey(userId, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.png';
  const safeExt = ALLOWED_EXTS.includes(ext) ? ext : '.png';
  const prefix = (env('AWS_S3_KEY_PREFIX') || 'questions').replace(/^\/+|\/+$/g, '');
  const id = `${userId || 'anon'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${prefix}/${id}${safeExt}`;
}

async function uploadQuestionImageToS3({ buffer, contentType, originalName, userId }) {
  const key = questionImageKey(userId, originalName);
  const input = {
    Bucket: env('AWS_S3_BUCKET'),
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  };
  const acl = env('AWS_S3_OBJECT_ACL');
  if (acl) input.ACL = acl;
  await getS3Client().send(new PutObjectCommand(input));
  return { key, url: publicUrlForKey(key) };
}

module.exports = {
  isS3Enabled,
  uploadQuestionImageToS3,
};
