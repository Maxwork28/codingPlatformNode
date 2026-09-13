const nodemailer = require('nodemailer');

function isSmtpConfigured() {
    return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
if (isSmtpConfigured()) {
    transporter = nodemailer.createTransport({
        service: process.env.SMTP_SERVICE || 'Gmail',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

async function sendEmail(to, subject, text) {
    if (!transporter) {
        console.warn('sendEmail: skipped (set SMTP_USER and SMTP_PASS to enable)');
        return { skipped: true };
    }
    await transporter.sendMail({
        from: process.env.SMTP_FROM || `"Admin" <${process.env.SMTP_USER}>`,
        to,
        subject,
        text,
    });
}

sendEmail.isSmtpConfigured = isSmtpConfigured;
module.exports = sendEmail;
module.exports.sendEmail = sendEmail;