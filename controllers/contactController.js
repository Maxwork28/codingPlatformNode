const sendEmail = require('../utils/sendEmail');

// Fixed email address to receive all contact form submissions
const CONTACT_RECIPIENT_EMAIL = 'harshraj7864@gmail.com'; // Change this to your desired email

/**
 * Handle contact form submission
 * @route POST /contact
 */
const submitContactForm = async (req, res) => {
    try {
        const { name, email, contact, content } = req.body;

        // Validation
        if (!name || !email || !contact || !content) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required: name, email, contact, and content'
            });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        // Prepare email content
        const subject = `New Contact Form Submission from ${name}`;
        const emailContent = `
You have received a new contact form submission:

Name: ${name}
Email: ${email}
Contact: ${contact}

Message:
${content}

---
This message was sent from the contact form on your coding platform.
        `;

        // Send email to the fixed recipient
        await sendEmail(CONTACT_RECIPIENT_EMAIL, subject, emailContent);

        // Send confirmation response
        res.status(200).json({
            success: true,
            message: 'Your message has been sent successfully. We will get back to you soon!'
        });

    } catch (error) {
        console.error('Error sending contact form email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message. Please try again later.',
            error: error.message
        });
    }
};

module.exports = {
    submitContactForm
};

