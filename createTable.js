const db = require("./index"); // Import MySQL connection from your main file

// ✅ Function to Create Table
async function createTables() {
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS donor_registration (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_type ENUM('Donor', 'Receiver') NOT NULL,
                organization_name VARCHAR(255),
                organization_type ENUM('Hotel', 'Restaurant', 'Mess', 'Other', 'NGO', 'Individual', 'Company') NOT NULL,
                phone VARCHAR(20) NOT NULL UNIQUE,
                address TEXT NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        // ✅ Execute Query using `await`
        await db.query(createTableQuery);
        console.log("✅ Table 'donor_registration' created successfully!");
    } catch (err) {
        console.error("❌ Error creating table:", err.message);
    } finally {
        db.end(); // Close database connection after execution
    }
}

// ✅ Run the function
createTables();
