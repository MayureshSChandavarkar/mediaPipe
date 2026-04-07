import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;
const KEYSTROKES_FILE = path.join(__dirname, 'keystrokes.json');

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Helper function to read the keystrokes file
 * Returns an empty array if the file doesn't exist
 */
async function readKeystrokes() {
  try {
    const data = await fs.readFile(KEYSTROKES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return empty array
    if (error.code === 'ENOENT') {
      return [];
    }
    console.error('Error reading keystrokes file:', error);
    return [];
  }
}

/**
 * Helper function to write keystrokes to file
 */
async function writeKeystrokes(data) {
  await fs.writeFile(KEYSTROKES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * POST /api/log
 * Receives pinch/keystroke data and appends it to keystrokes.json
 * 
 * Expected payload:
 * {
 *   timestamp: string (ISO format),
 *   coordinates: { x: number, y: number, z: number }
 * }
 */
app.post('/api/log', async (req, res) => {
  try {
    const { timestamp, coordinates } = req.body;

    // Validate payload
    if (!timestamp || !coordinates) {
      return res.status(400).json({ 
        error: 'Invalid payload. Required: timestamp, coordinates' 
      });
    }

    if (typeof coordinates.x !== 'number' || 
        typeof coordinates.y !== 'number' || 
        typeof coordinates.z !== 'number') {
      return res.status(400).json({ 
        error: 'Invalid coordinates. Required: x, y, z (numbers)' 
      });
    }

    // Read existing keystrokes
    const keystrokes = await readKeystrokes();

    // Append new keystroke
    keystrokes.push({
      timestamp,
      coordinates,
      receivedAt: new Date().toISOString()
    });

    // Write back to file
    await writeKeystrokes(keystrokes);

    console.log(`[${new Date().toISOString()}] Pinch logged at:`, coordinates);

    res.status(200).json({ 
      success: true, 
      message: 'Keystroke logged successfully',
      totalKeystrokes: keystrokes.length
    });

  } catch (error) {
    console.error('Error logging keystroke:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/keystrokes
 * Returns all logged keystrokes (useful for debugging)
 */
app.get('/api/keystrokes', async (req, res) => {
  try {
    const keystrokes = await readKeystrokes();
    res.status(200).json(keystrokes);
  } catch (error) {
    console.error('Error fetching keystrokes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/keystrokes
 * Clears all logged keystrokes (useful for testing)
 */
app.delete('/api/keystrokes', async (req, res) => {
  try {
    await writeKeystrokes([]);
    console.log('Keystrokes cleared');
    res.status(200).json({ success: true, message: 'Keystrokes cleared' });
  } catch (error) {
    console.error('Error clearing keystrokes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║   Hand Tracking Backend Server                         ║
║   Running on http://localhost:${PORT}                     ║
╠════════════════════════════════════════════════════════╣
║   Endpoints:                                           ║
║   POST   /api/log         - Log a pinch event          ║
║   GET    /api/keystrokes  - Get all logged keystrokes  ║
║   DELETE /api/keystrokes  - Clear all keystrokes       ║
║   GET    /health          - Health check               ║
╚════════════════════════════════════════════════════════╝
  `);
});
