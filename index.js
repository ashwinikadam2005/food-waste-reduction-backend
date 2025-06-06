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
app.use(
    cors({
        origin: "http://localhost:3000",
        credentials: true,
    })
);
app.use(express.json());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
const analyticsRoutes = require("./routes/analytics")(db);
app.use("/analytics", analyticsRoutes);


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

        await db.query("DELETE FROM donor_registration WHERE id = ?", [id]);
        res.json({ message: "User blocked successfully" });
    } catch (err) {
        console.error("Error blocking user:", err.message);
        res.status(500).json({ error: err.message });
    }
});




const cookie = require('cookie');  // Make sure this module is imported to handle cookies
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  console.log("Login attempt for email:", email);

  try {
    // Donor login
    const [donorUsers] = await db.query("SELECT * FROM donor WHERE email = ?", [email]);
    if (donorUsers.length > 0) {
      const donor = donorUsers[0];
      const isMatch = await bcrypt.compare(password, donor.password_hash);
      if (isMatch) {
        const role = "donor"; // ✅ FIXED: define role
        res.cookie("email", email, { httpOnly: true });
        res.cookie("role", role, { httpOnly: true });

        console.log("✅ Donor Logged In:", email, "Role:", role);
        return res.status(200).json({ role, message: "Login successful!" });
      }
    }

    // Receiver login
    const [receiverUsers] = await db.query("SELECT * FROM receivers WHERE email = ?", [email]);
    if (receiverUsers.length > 0) {
      const receiver = receiverUsers[0];
      const isMatch = await bcrypt.compare(password, receiver.password_hash);
      if (isMatch) {
        const role = "receiver"; // ✅ FIXED: define role
        res.cookie("email", email, { httpOnly: true });
        res.cookie("role", role, { httpOnly: true });

        console.log("✅ Receiver Logged In:", email, "Role:", role);
        return res.status(200).json({ role, message: "Login successful!" });
      }
    }

    console.log("❌ Invalid login attempt for:", email);
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
app.get("/api/my-donations", async (req, res) => {
  const email = req.cookies.email;
  const role = req.cookies.role;

  console.log("📥 API hit with email:", email, "role:", role); // ✅ LOGGING

  if (!email || !role || role !== "donor") {
    console.warn("🚫 Access denied. Missing or invalid role/email.");
    return res.status(403).json({ message: "Access denied" });
  }

  try {
    const [donations] = await db.query(
      `SELECT * FROM donations WHERE email = ? ORDER BY created_at DESC`,
      [email]
    );

    console.log(`✅ Found ${donations.length} donations for ${email}`);
    res.json(donations);
  } catch (err) {
    console.error("❌ DB Error fetching donations:", err.message);
    res.status(500).json({ message: "Server error" });
  }
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
        donor.email,
        d.status
      FROM donations d
      JOIN donor ON d.donor_id = donor.id
      WHERE d.status = 'Pending'
      ORDER BY d.created_at DESC
    `);

    res.json(results);
  } catch (err) {
    console.error("Error fetching donations:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});



// Accept donation by recipient
// Accept donation by receiver (dynamic by email)
app.post("/donations/accept/:id", async (req, res) => {
  const donationId = req.params.id;
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    const [receiverRows] = await db.query(
      `SELECT id FROM receivers WHERE email = ?`,
      [email]
    );

    if (receiverRows.length === 0) {
      return res.status(404).json({ error: "Receiver not found" });
    }

    const receiverId = receiverRows[0].id;

    // Check if donation is already accepted
    const [donationCheck] = await db.query(
      `SELECT status FROM donations WHERE id = ?`,
      [donationId]
    );

    if (donationCheck.length === 0) {
      return res.status(404).json({ error: "Donation not found" });
    }

    if (donationCheck[0].status !== "Pending") {
      return res.status(400).json({ error: "Donation is already Accepted." });
    }

    await db.query(
      `UPDATE donations 
       SET status = 'Accepted', 
           accepted_by = ?, 
           accepted_at = NOW() 
       WHERE id = ?`,
      [receiverId, donationId]
    );
    
    res.json({ message: "Donation accepted successfully" });
  } catch (err) {
    console.error("Error accepting donation:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/donations/accepted", async (req, res) => {
  try {
      const [results] = await db.query(`
          SELECT 
          d.id AS donation_id,
          d.food_name,
          d.food_category,
          d.quantity,
          d.expiry_date,
          d.status,
          d.accepted_at,
          donor.organization_name AS donor_name,
          r.organization_name AS receiver_name
          FROM donations d

          JOIN donor ON d.donor_id = donor.id
          LEFT JOIN receivers r ON d.accepted_by = r.id
          WHERE d.status = 'Accepted'
          ORDER BY d.created_at DESC
      `);
      res.json(results);
  } catch (err) {
      console.error("Error fetching accepted donations:", err);
      res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get accepted donations for a specific receiver (history)
app.get("/donations/receiver/history", async (req, res) => {
  const email = req.query.email;  // Fetch the email from the query parameter

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    // Update the SQL query to join donations with receivers table and filter by receiver email
    const [results] = await db.query(`
      SELECT 
        d.id AS donation_id,
        d.food_name,
        d.food_category,
        d.quantity,
        d.expiry_date,
        d.status,
        d.accepted_at,
        donor.organization_name AS donor_name,
        r.organization_name AS receiver_name
      FROM donations d
      JOIN donor ON d.donor_id = donor.id
      JOIN receivers r ON d.accepted_by = r.id  -- Ensure you're joining with the receivers table
      WHERE d.status = 'Accepted' AND r.email = ?  -- Match by receiver's email
      ORDER BY d.created_at DESC
    `, [email]);

    res.json(results);
  } catch (err) {
    console.error("Error fetching donation history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get donation history for a specific donor
app.get("/donations/donor/history", async (req, res) => {
  const email = req.query.email;  // Fetch the email from the query parameter

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    const [results] = await db.query(`
      SELECT 
        d.id AS donation_id,
        d.food_name,
        d.food_category,
        d.quantity,
        d.expiry_date,
        d.status,
        donor.organization_name AS donor_name,
        r.organization_name AS receiver_name
      FROM donations d
      JOIN donor ON d.donor_id = donor.id
      LEFT JOIN receivers r ON d.accepted_by = r.id  -- Join receivers table to get receiver name
      WHERE d.donor_email = ?  -- Match by donor's email
      ORDER BY d.created_at DESC
    `, [email]);

    res.json(results);
  } catch (err) {
    console.error("Error fetching donor donation history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Mark a donation as completed
// PUT /api/donations/:id/complete
// Mark a donation as completed
// Backend: Mark donation as completed
app.post("/api/mark-completed/:id", async (req, res) => {
  const donationId = req.params.id;

  try {
    const [result] = await db.query(
      `UPDATE donations SET status = 'completed' WHERE id = ?`,
      [donationId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Donation not found." });
    }

    res.json({ message: "Donation marked as completed" });
  } catch (err) {
    console.error("Error marking donation as completed:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});





app.get("/analytics/category-wise-donations", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT 
        food_category, 
        COUNT(id) AS donations_count 
      FROM donations 
      WHERE status = 'Accepted'
      GROUP BY food_category
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching category-wise donations:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
app.get("/analytics/quantity-over-time", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT 
        DATE(created_at) AS date, 
        SUM(quantity) AS total_quantity 
      FROM donations 
      WHERE status = 'Accepted'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching quantity over time:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
app.get("/analytics/status-comparison", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT 
        DATE(created_at) AS date, 
        COUNT(CASE WHEN status = 'Accepted' THEN 1 END) AS accepted,
        COUNT(CASE WHEN status = 'Pending' THEN 1 END) AS pending
      FROM donations
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching status comparison:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
app.get("/analytics/top-donors", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT 
        donor.organization_name, 
        SUM(quantity) AS total_donated
      FROM donations d
      JOIN donor ON d.donor_id = donor.id
      WHERE d.status = 'Accepted'
      GROUP BY donor.organization_name
      ORDER BY total_donated DESC
      LIMIT 10
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching top donors:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
// GET: Fetch like count and user like status
app.get("/api/likes", async (req, res) => {
  const userEmail = req.query.email;
  if (!userEmail) return res.status(400).json({ error: "Email is required" });

  try {
    // Fetch total likes
    const [likeRows] = await db.query("SELECT total_likes FROM likes WHERE id = 1");

    // Check if the user has already liked
    const [userRows] = await db.query("SELECT * FROM user_likes WHERE email = ?", [userEmail]);

    res.json({
      totalLikes: likeRows[0]?.total_likes || 0,
      userHasLiked: userRows.length > 0,
    });
  } catch (err) {
    console.error("GET /api/likes error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST: Handle like action
app.post("/api/likes", async (req, res) => {
  const userEmail = req.body.email;
  if (!userEmail) return res.status(400).json({ error: "Email is required" });

  try {
    // Check if the user has already liked
    const [userExists] = await db.query("SELECT * FROM user_likes WHERE email = ?", [userEmail]);
    if (userExists.length > 0) {
      return res.status(400).json({ message: "User already liked" });
    }

    // Add user to 'user_likes' table and increase the total like count
    await db.query("INSERT INTO user_likes (email) VALUES (?)", [userEmail]);
    await db.query("UPDATE likes SET total_likes = total_likes + 1 WHERE id = 1");

    // Fetch the updated like count
    const [updatedLikes] = await db.query("SELECT total_likes FROM likes WHERE id = 1");

    res.json({
      message: "Liked successfully",
      totalLikes: updatedLikes[0].total_likes,
    });
  } catch (err) {
    console.error("POST /api/likes error:", err);
    res.status(500).json({ error: "Server error" });
  }
});




// Middleware for CSRF protection
app.use(csrfProtection);

// Route to get the CSRF token
app.get("/api/csrf-token", (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});


// Feedback submission route
app.post("/api/feedback", async (req, res) => {
  try {
    const { name, feedback } = req.body;

    if (!name || !feedback) {
      return res.status(400).json({ error: "Name and feedback are required." });
    }

    // ✅ Corrected table name: `feedbacks`
    const query = "INSERT INTO feedbacks (name, feedback) VALUES (?, ?)";
    await db.query(query, [name, feedback]);

    res.status(201).json({ message: "Feedback submitted successfully!" });
  } catch (error) {
    console.error("Error inserting feedback:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}); 

// feedback list API to match frontend
app.get('/api/feedbacks', async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM feedbacks ORDER BY created_at DESC');
    res.json(results);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = db;
