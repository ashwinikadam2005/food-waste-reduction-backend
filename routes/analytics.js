const express = require("express");

module.exports = (db) => {
  const router = express.Router();

  // Helper function for executing queries
  const executeQuery = async (sql) => {
    try {
      const [results] = await db.execute(sql);
      return results;
    } catch (err) {
      throw err;
    }
  };

  router.get("/statistics-summary", async (req, res) => {
    const sql = `
      SELECT 
        COUNT(*) AS total,
        SUM(status = 'accepted') AS accepted,
        SUM(status = 'pending') AS pending
      FROM donations
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results[0]);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  router.get("/category-wise-donations", async (req, res) => {
    const sql = `
      SELECT food_category, COUNT(*) AS donations_count
      FROM donations
      GROUP BY food_category
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  router.get("/quantity-over-time", async (req, res) => {
    // Assuming quantity is stored in a consistent numeric format.
    const sql = `
      SELECT DATE(created_at) AS date, SUM(CAST(quantity AS UNSIGNED)) AS total_quantity
      FROM donations
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  router.get("/status-comparison", async (req, res) => {
    const sql = `
      SELECT 
        DATE(created_at) AS date,
        SUM(status = 'accepted') AS accepted,
        SUM(status = 'pending') AS pending
      FROM donations
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  router.get("/top-donors", async (req, res) => {
    // Join donations with donors to fetch the donor names
    const sql = `
      SELECT donor.email AS organization_name, SUM(CAST(donations.quantity AS UNSIGNED)) AS total_donated
      FROM donations
      JOIN donor ON donations.donor_id = donor.id
      GROUP BY donor.email
      ORDER BY total_donated DESC
      LIMIT 5
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  router.get("/recent-donations", async (req, res) => {
    const sql = `
      SELECT food_name, donor.email AS donor_name, donations.created_at
      FROM donations
      JOIN donor ON donations.donor_id = donor.id
      ORDER BY donations.created_at DESC
      LIMIT 5
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  // Note: Adjust `location_name` field if it exists or is planned to be added to donations table
  router.get("/location-data", async (req, res) => {
    const sql = `
      SELECT location_name, COUNT(*) AS donation_count
      FROM donations
      GROUP BY location_name
    `;
    try {
      const results = await executeQuery(sql);
      res.json(results);
    } catch (err) {
      res.status(500).send(err);
    }
  });

  return router;
};
