require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.ADMIN_EMAIL, // your email
    pass: process.env.EMAIL_PASSWORD, // your app password
  },
});

async function sendTestEmail() {
  try {
    const info = await transporter.sendMail({
      from: process.env.ADMIN_EMAIL,
      to: "your-email@gmail.com", // Change this to your email
      subject: "Test Email from Nodemailer",
      text: "This is a test email.",
    });

    console.log("📩 Email sent successfully:", info.response);
  } catch (error) {
    console.error("❌ Email send error:", error);
  }
}

sendTestEmail();
