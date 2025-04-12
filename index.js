require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const csrf = require("csurf");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 5001;

// ✅ Create a MySQL Connection Pool with Promises
const db = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root", // Change for security
    database: process.env.DB_NAME || "foodwastereduction",
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}).promise();

// ✅ Test the Database Connection
async function testDBConnection() {
    try {
        const [rows] = await db.query("SELECT 1");
        console.log("✅ MySQL Database Connected Successfully!");
    } catch (err) {
        console.error("❌ Database Connection Error:", err.message);
        process.exit(1);
    }
}
testDBConnection();

// ✅ Middleware Setup
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
    cors({
        origin: "http://localhost:3000",
        credentials: true,
    })
);

// ✅ Express Session (must come before CSRF middleware)
app.use(
    session({
        secret: process.env.SESSION_SECRET || "your_secret_key",
        resave: false,
        saveUninitialized: true,
        cookie: {
            httpOnly: true,
            secure: false,
            maxAge: 1000 * 60 * 15,
        },
    })
);

// ✅ CSRF Protection Middleware Setup
const csrfProtection = csrf({ cookie: true });

// Exclude routes that start with /login, /register, or /api/contact from CSRF protection.
app.use((req, res, next) => {
    const skipRoutes = ["/login", "/register", "/api/contact","/donate"];
    if (skipRoutes.some(route => req.path.startsWith(route)) && req.method === "POST") {
        return next();
    }
    csrfProtection(req, res, next);
});

// ✅ Route to Fetch CSRF Token for Frontend
app.get("/csrf-token", (req, res) => {
    // Send CSRF token in a cookie and in the JSON response.
    res.cookie("XSRF-TOKEN", req.csrfToken(), { httpOnly: false });
    res.json({ csrfToken: req.csrfToken() });
});

// ✅ API Route to Register a Donor
app.post("/register", async (req, res) => {
    try {
        const { user_type, organization_name, organization_type, phone, address, email, password } = req.body;

        if (!user_type || !organization_name || !organization_type || !phone || !address || !email || !password) {
            return res.status(400).json({ message: "All fields are required!" });
        }

        // Check if email already exists in temp_users or donor_registration
        const [tempExists] = await db.query("SELECT * FROM temp_users WHERE email = ?", [email]);
        const [permanentExists] = await db.query("SELECT * FROM donor_registration WHERE email = ?", [email]);

        if (tempExists.length || permanentExists.length) {
            return res.status(400).json({ message: "Email already registered or pending verification!" });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Store in temp_users
        await db.query(`
          INSERT INTO temp_users (email, user_type, organization_name, organization_type, phone, address, password_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [email, user_type, organization_name, organization_type, phone, address, hashedPassword]);

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.ADMIN_EMAIL,
                pass: process.env.EMAIL_PASSWORD,
            },
        });

        const mailOptions = {
            from: process.env.ADMIN_EMAIL,
            to: email,
            subject: "Your OTP for Registration",
            text: `Your OTP code is ${otp}. It is valid for 5 minutes.`,
        };

        await transporter.sendMail(mailOptions);

        await db.query(
            "INSERT INTO otp_verification (email, otp, created_at) VALUES (?, ?, NOW())",
            [email, otp]
        );

        res.status(201).json({ success: true, message: "OTP sent. Please verify to complete registration.", email });

    } catch (error) {
        console.error("Error Registering Donor:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

app.post("/verify-otp", async (req, res) => {
    try {
      const { email, otp } = req.body;
  
      const [otpRows] = await db.query(
        "SELECT * FROM otp_verification WHERE email = ? ORDER BY created_at DESC LIMIT 1",
        [email]
      );
  
      if (!otpRows.length || otpRows[0].otp !== otp) {
        return res.status(400).json({ message: "Invalid or expired OTP!" });
      }
  
      // Get data from temp_users
      const [userRows] = await db.query("SELECT * FROM temp_users WHERE email = ?", [email]);
  
      if (!userRows.length) {
        return res.status(404).json({ message: "User not found!" });
      }
  
      const user = userRows[0];
  
      // ✅ Insert only into donor_registration
      await db.query(`
        INSERT INTO donor_registration ( user_type, organization_name, organization_type, phone, address,email, password_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ user.user_type, user.organization_name, user.organization_type, user.phone, user.address,user.email, user.password_hash]);
  
      // 🧹 Clean up temp storage
      await db.query("DELETE FROM temp_users WHERE email = ?", [email]);
      await db.query("DELETE FROM otp_verification WHERE email = ?", [email]);
  
      return res.status(200).json({ message: "OTP Verified. Registration Complete!" });
  
    } catch (error) {
      console.error("OTP Verification Error:", error);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });
    

// ✅ Fetch all users from donor_registration
app.get("/users", async (req, res) => {
    try {
        const [results] = await db.query("SELECT * FROM donor_registration");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ✅ Approve user and move to Donor/Receivers table
// ✅ Approve user and send email notification
// ✅ Approve user and send email notification
app.post("/approve/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { userType } = req.body;

        if (!userType) {
            return res.status(400).json({ error: "User type is required" });
        }

        const targetTable = userType === "Donor" ? "donor" : "receivers";

        // ✅ Fetch User Details
        const [userData] = await db.query("SELECT * FROM donor_registration WHERE id = ?", [id]);
        if (!userData || userData.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userData[0];

        // ✅ Move User to Final Table
        await db.query(
            `INSERT INTO ${targetTable} (organization_name, organization_type, phone, address, email, password_hash, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.organization_name, user.organization_type, user.phone, user.address, user.email, user.password_hash, user.created_at]
        );

        // ✅ Remove from donor_registration table
        await db.query("DELETE FROM donor_registration WHERE id = ?", [id]);

        // ✅ Send Approval Email
        const mailOptions = {
            from: `"Admin" <${process.env.ADMIN_EMAIL}>`,
            to: user.email,
            subject: "Your Registration Request has been Approved!",
            text: `Dear ${user.organization_name},\n\nYour registration request has been approved! You can now log in and start using our services.\n\nBest Regards,\nAdmin Team`,
            html: `<p>Dear <strong>${user.organization_name}</strong>,</p>
                   <p>Your registration request has been <strong>approved</strong>! 🎉</p>
                   <p>You can now <a href="http://localhost:3000/login">log in</a> and start using our services.</p>
                   <p>Best Regards,<br><strong>Admin Team</strong></p>`
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log("✅ Approval email sent successfully to:", user.email);
        } catch (emailError) {
            console.error("❌ Error sending approval email:", emailError);
        }

        res.json({ message: `User moved to ${targetTable} successfully and email sent.` });
    } catch (err) {
        console.error("Error approving user:", err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ Block user (mark as blocked)
app.post("/block/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const [userData] = await db.query("SELECT * FROM donor_registration WHERE id = ?", [id]);
        if (userData.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        await db.query("UPDATE donor_registration SET status = 'Blocked' WHERE id = ?", [id]);
        res.json({ message: "User blocked successfully" });
    } catch (err) {
        console.error("Error blocking user:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ✅ Login Route (CSRF skipped)
app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    console.log("Login attempt for email:", email);

    try {
        // Check Donor Table
        const [donorUsers] = await db.query("SELECT * FROM donor WHERE email = ?", [email]);
        if (donorUsers.length > 0) {
            const donor = donorUsers[0];
            const isMatch = await bcrypt.compare(password, donor.password_hash);
            console.log("Password Match for Donor:", isMatch);
            if (isMatch) {
                return res.status(200).json({ role: "donor", message: "Login successful!" });
            }
        }

        // Check Receiver Table
        const [receiverUsers] = await db.query("SELECT * FROM receivers WHERE email = ?", [email]);
        if (receiverUsers.length > 0) {
            const receiver = receiverUsers[0];
            const isMatch = await bcrypt.compare(password, receiver.password_hash);
            console.log("Password Match for Receiver:", isMatch);
            if (isMatch) {
                return res.status(200).json({ role: "receiver", message: "Login successful!" });
            }
        }

        console.log("Invalid login attempt for:", email);
        return res.status(401).json({ message: "Invalid email or password" });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// ✅ Nodemailer Transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.ADMIN_EMAIL,
      pass: process.env.EMAIL_PASSWORD,
    },
    logger: true,   // enable logging
    debug: true     // show debug output
  });
  transporter.verify((error, success) => {
    if (error) {
      console.error("❌ Email transporter error:", error);
    } else {
      console.log("✅ Email transporter is ready to send messages");
    }
  });
  
  // ✅ API Route to Handle Contact Form Submission
  app.post("/api/contact", async (req, res) => {
    console.log("📩 POST /api/contact hit with:", req.body);
  
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      console.error("❌ Missing fields in request.");
      return res.status(400).json({ message: "All fields are required" });
    }
  
    // ✅ Insert into MySQL
    try {
      const query = "INSERT INTO contacts (name, email, message) VALUES (?, ?, ?)";
      await db.query(query, [name, email, message]);
      console.log("✅ Data inserted into MySQL");
  
      // ✅ Send Email
      const mailOptions = {
        from: `${name} <${email}>`,
        to: process.env.ADMIN_EMAIL,
        subject: "New Contact Form Submission",
        text: `You have received a new message from:\n\nName: ${name}\nEmail: ${email}\nMessage: ${message}`,
      };
  
      console.log("📤 Sending email...");
      const info = await transporter.sendMail(mailOptions);
      console.log("✅ Email sent successfully:", info.response);
  
      return res.status(200).json({ message: "Message sent successfully!" });
  
    } catch (error) {
      console.error("❌ Error processing request:", error);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });
  


// ✅ Donation Route
// ✅ Donation Route (with donor validation)
app.post("/donate", async (req, res) => {
  console.log("BODY:", req.body);
console.log("Email variable:", req.body.email);

    try {
      const {
        email, // ✅ Get donor email
        food_category,
        food_name,
        quantity,
        expiry_date,
        preparation_date,
        storage_instructions,
      } = req.body;
  
      // Validate required fields
      if (!email || !food_name || !quantity) {
        return res.status(400).json({ message: "Email, food name, and quantity are required!" });
      }
  
      // 🔍 Find donor by email
      const [donorRows] = await db.query("SELECT id FROM donor WHERE email = ?", [email]);
  
      if (donorRows.length === 0) {
        return res.status(404).json({ message: "No donor found with this email." });
      }
  
      const donor_id = donorRows[0].id;
  
      // 💾 Insert donation with donor_id
      await db.query(
        `INSERT INTO donations 
          (donor_id, food_category, food_name, quantity, expiry_date, preparation_date, storage_instructions,email) 
         VALUES (?, ?, ?, ?, ?, ?, ?,? )`,
        [donor_id, food_category, food_name, quantity, expiry_date, preparation_date, storage_instructions,email]
      );
  
      res.status(201).json({ message: "🎉 Food donation recorded successfully!" });
  
    } catch (error) {
      console.error("❌ Error in food donation:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  });
  

// GET /my‑donations?email=foo@bar.com
app.get("/api/my-donations", (req, res) => {
  const email = req.cookies.userEmail?.trim();
  console.log("Email from cookie:", email);

  if (!email) {
    return res.status(400).json({ message: "Email not found in cookies" });
  }

  const sql = "SELECT * FROM donations WHERE email = ?";

  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error("Error fetching donations:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
    res.json(results);
  });
});

app.get("/donations", async (req, res) => {
    try {
        const [results] = await db.query(`
SELECT 
  d.id AS donation_id,
  d.food_category,
  d.food_name,
  d.quantity,
  d.expiry_date,
  d.preparation_date,
  d.storage_instructions,
  d.created_at,
  donor.organization_name,
  donor.phone,
  donor.address,
  donor.email
FROM donations d
JOIN donor ON d.donor_id = donor.id
ORDER BY d.created_at DESC

        `);

        res.json(results);
    } catch (err) {
        console.error("Error fetching donations:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});





app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = db;
