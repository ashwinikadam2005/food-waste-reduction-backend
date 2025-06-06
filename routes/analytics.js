const express = require("express");
const fs = require('fs');
const { Parser } = require('json2csv');  // Install json2csv: npm install json2csv

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
    SUM(status = 'pending') AS pending,
    SUM(status = 'completed') AS completed
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
  router.get("/quantity-breakdown-over-time", async (req, res) => {
    const sql = `
SELECT 
  DATE(created_at) AS date,
  SUM(
    CASE 
      WHEN LOWER(quantity) LIKE '%kg%' THEN CAST(TRIM(REPLACE(LOWER(quantity), 'kg', '')) AS UNSIGNED)
      ELSE 0
    END
  ) AS total_kg,
  SUM(
    CASE 
      WHEN LOWER(quantity) LIKE '%plate%' THEN CAST(
        TRIM(
          REPLACE(
            REPLACE(LOWER(quantity), 'plates', ''),
            'plate', ''
          )
        ) AS UNSIGNED
      )
      ELSE 0
    END
  ) AS total_plates
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
        SUM(status = 'pending') AS pending,
        SUM(status = 'completed') AS completed

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
// router.get("/top-donors", async (req, res) => {
  const sql = `
  SELECT 
    donor.email AS organization_name,
    SUM(
      CASE 
        WHEN LOWER(donations.quantity) LIKE '%kg%' 
        THEN CAST(TRIM(REPLACE(LOWER(donations.quantity), 'kg', '')) AS UNSIGNED)
        ELSE 0
      END
    ) AS total_kg,
    SUM(
      CASE 
        WHEN LOWER(donations.quantity) LIKE '%plate%' 
        THEN CAST(
          TRIM(
            REPLACE(
              REPLACE(LOWER(donations.quantity), 'plates', ''),
              'plate', ''
            )
          ) AS UNSIGNED
        )
        ELSE 0
      END
    ) AS total_plates
  FROM donations
  JOIN donor ON donations.donor_id = donor.id
  GROUP BY donor.email
  ORDER BY (total_kg + total_plates) DESC
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
// POST /analytics/custom-report
router.post('/custom-report', async (req, res) => {
  const { fromDate, toDate, category } = req.body;

  // Check for required parameters
  if (!fromDate || !toDate) {
    return res.status(400).send("From date and to date are required");
  }

  try {
    // SQL query to fetch food name, donor name, receiver name, food category, total kg, and total plates
// SQL query to fetch donations filtered by the selected category
// SQL query to fetch donations filtered by the selected category
const query = `
  SELECT 
    donations.food_name,
    donations.food_category,
    donor.organization_name AS donor_name,
    receivers.organization_name AS receiver_name,
    SUM(CASE 
            WHEN donations.quantity LIKE '%kg%' THEN CAST(REPLACE(donations.quantity, 'kg', '') AS UNSIGNED)
            ELSE 0 
        END) AS total_kg,
    SUM(CASE 
            WHEN donations.quantity LIKE '%plate%' OR donations.quantity LIKE '%plates%' THEN CAST(REPLACE(REPLACE(donations.quantity, 'plates', ''), 'plate', '') AS UNSIGNED)
            ELSE 0 
        END) AS total_plates
  FROM donations
  LEFT JOIN donor ON donations.donor_id = donor.id
  LEFT JOIN receivers ON donations.accepted_by = receivers.id
  WHERE DATE(donations.created_at) BETWEEN ? AND ?  
  AND donations.accepted_by IS NOT NULL
  ${category && category !== 'both' ? 'AND donations.food_category = ?' : ''}
  GROUP BY donations.food_name, donations.food_category, donor.organization_name, receivers.organization_name;
`;

const params = category && category !== 'both' ? [fromDate, toDate, category === 'veg' ? 'Vegetarian' : 'Non-Vegetarian'] : [fromDate, toDate];
    // Execute the query to get data
    const [results] = await db.execute(query, params);

    // Prepare data for CSV conversion
// Prepare data for CSV conversion
const csvData = results.map(item => ({
  FoodName: item.food_name,
  DonorName: item.donor_name,
  ReceiverName: item.receiver_name,
  Category: item.food_category,
  TotalKG: item.total_kg,
  TotalPlates: item.total_plates,
  FromDate: fromDate,
  ToDate: toDate
}));

if (!csvData.length) {
  return res.status(404).send("No data found for the selected criteria.");
}

// Convert data to CSV
const json2csvParser = new Parser();
const csv = json2csvParser.parse(csvData);

    // Set response headers for CSV download
    res.header('Content-Type', 'text/csv');
    res.attachment('donations_report.csv');
    res.send(csv);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating report");
  }
});

  return router;
};
