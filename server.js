require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const db = require('./db'); // mysql2/promise wrapper

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve uploads and frontend static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/', express.static(path.join(__dirname, 'public')));

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Multer setup: store files locally in uploads/
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage });

// Nodemailer transporter using SMTP credentials from .env
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '465'),
  secure: process.env.MAIL_SECURE === 'true',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// Simple verification on startup
transporter.verify().then(() => {
  console.log('Nodemailer ready');
}).catch(err => {
  console.warn('Nodemailer verify failed (check env):', err.message);
});

// API endpoints
app.post('/api/users', upload.single('profile_pic'), async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    let profile_pic = null;
    if (req.file) profile_pic = `/uploads/${req.file.filename}`;

    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const conn = await db.getConnection();
    const [result] = await conn.execute(
      'INSERT INTO users (name, email, phone, profile_pic) VALUES (?, ?, ?, ?)',
      [name, email, phone || null, profile_pic]
    );
    const insertedId = result.insertId;

    // Send confirmation email
    const mailOptions = {
      from: `"${process.env.FROM_NAME || 'App'}" <${process.env.FROM_EMAIL || process.env.MAIL_USER}>`,
      to: email,
      subject: 'Registration Successful - Malware Tracker',
      text: `Hi ${name},\n\nYour registration on Malware Tracker (Malware Analysis & Log Tracking) was successful.\n\nThanks,\n${process.env.FROM_NAME || 'Team'}`,
      html: `<h2>Registration Successful</h2>
             <p>Hi <b>${name}</b>,</p>
             <p>Your registration on <b>Malware Tracker</b> (Malware Analysis & Log Tracking) was successful.</p>
             <p>We saved the following information:</p>
             <ul>
               <li><b>Name:</b> ${name}</li>
               <li><b>Email:</b> ${email}</li>
               <li><b>Phone:</b> ${phone || 'N/A'}</li>
             </ul>
             <p>Thanks,<br/>${process.env.FROM_NAME || 'Team'}</p>`
    };

    transporter.sendMail(mailOptions).then(info => {
      console.log('Confirmation email sent:', info.messageId);
    }).catch(err => {
      console.warn('Failed to send confirmation email:', err.message);
    });

    // Return created user
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [insertedId]);
    conn.release();
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const conn = await db.getConnection();
    const [rows] = await conn.execute('SELECT * FROM users ORDER BY id DESC');
    conn.release();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const conn = await db.getConnection();
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
    conn.release();
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (optionally new profile_pic upload)
app.put('/api/users/:id', upload.single('profile_pic'), async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, phone } = req.body;
    const conn = await db.getConnection();

    // Get current to optionally remove old file
    const [existing] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
    if (existing.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'User not found' });
    }

    let profile_pic = existing[0].profile_pic;
    if (req.file) {
      // remove old file if exists locally
      if (profile_pic) {
        try {
          const oldPath = path.join(__dirname, profile_pic);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch (e) { /* ignore */ }
      }
      profile_pic = `/uploads/${req.file.filename}`;
    }

    await conn.execute(
      'UPDATE users SET name = ?, email = ?, phone = ?, profile_pic = ? WHERE id = ?',
      [name || existing[0].name, email || existing[0].email, phone || existing[0].phone, profile_pic, id]
    );

    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
    conn.release();
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const conn = await db.getConnection();
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'User not found' });
    }

    // remove file
    if (rows[0].profile_pic) {
      try {
        const filePath = path.join(__dirname, rows[0].profile_pic);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) { /* ignore */ }
    }

    await conn.execute('DELETE FROM users WHERE id = ?', [id]);
    conn.release();
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fallback for SPA files (serve index)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
