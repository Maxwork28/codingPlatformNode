const crypto = require('crypto');
module.exports = () => crypto.randomBytes(5).toString('hex');