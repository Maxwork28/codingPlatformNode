const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: 'harshraj7864@gmail.com',
        pass: 'dpqiojgltontoiav'
    }
});

module.exports = async (to, subject, text) => {
    await transporter.sendMail({
        from: '"Admin" <harshraj7864@gmail.com>', // Fixed syntax
        to,
        subject,
        text
    });
};