# Hand Tracking Pinch Detection PoC

A proof-of-concept web application for security research that tracks hand landmarks via webcam using Google MediaPipe and detects pinch gestures.

## Project Structure

```
mediaPipe/
├── frontend/                 # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx          # Main component with MediaPipe integration
│   │   ├── main.jsx         # React entry point
│   │   └── index.css        # Styles
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
│
├── backend/                  # Node.js + Express backend
│   ├── server.js            # Express server with logging endpoints
│   ├── package.json
│   └── keystrokes.json      # Auto-generated log file
│
└── README.md
```

## Quick Start

### 1. Start the Backend Server

```bash
cd backend
npm install
npm start
```

The server will run at `http://localhost:3001`

### 2. Start the Frontend

In a new terminal:

```bash
cd frontend
npm install
npm run dev
```

The app will open at `http://localhost:5173`

### 3. Grant Camera Permissions

When prompted by your browser, allow camera access.

## How It Works

1. **Webcam Capture**: The app captures your webcam feed and displays it on a canvas
2. **Hand Detection**: MediaPipe HandLandmarker processes each frame to detect hands
3. **Landmark Tracking**: The app tracks the Thumb Tip (Landmark 4) and Index Finger Tip (Landmark 8)
4. **Pinch Detection**: When the 3D distance between thumb and index falls below the threshold (default: 0.04), a "pinch" is detected
5. **Debouncing**: A 300ms cooldown prevents rapid duplicate events
6. **Logging**: Each pinch event sends a POST request to the backend with timestamp and 3D coordinates

## Configuration

In `frontend/src/App.jsx`, you can adjust:

```javascript
const PINCH_THRESHOLD = 0.04;        // Lower = requires closer pinch
const DEBOUNCE_COOLDOWN_MS = 300;    // Cooldown between pinch events
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/log` | Log a pinch event |
| GET | `/api/keystrokes` | Get all logged keystrokes |
| DELETE | `/api/keystrokes` | Clear all keystrokes |
| GET | `/health` | Health check |

### Pinch Event Payload

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "coordinates": {
    "x": 0.4523,
    "y": 0.3821,
    "z": -0.0234
  }
}
```

## Technologies Used

- **Frontend**: React 18, Vite, @mediapipe/tasks-vision
- **Backend**: Node.js, Express, CORS
- **Storage**: Local filesystem (keystrokes.json)

## Browser Support

Works best in:
- Chrome (recommended)
- Edge
- Firefox

Requires WebGL support for GPU acceleration.
