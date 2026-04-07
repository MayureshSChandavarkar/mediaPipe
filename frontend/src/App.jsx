import { useEffect, useRef, useState, useCallback } from 'react';
import { FilesetResolver, HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

// Pinch detection threshold - distance below which thumb and index are considered "pinching"
// Adjust this value based on testing (lower = requires closer pinch)
const PINCH_THRESHOLD = 0.04;

// Debounce cooldown in milliseconds to prevent rapid-fire pinch events
const DEBOUNCE_COOLDOWN_MS = 300;

// Backend API endpoint
const API_ENDPOINT = 'http://localhost:3001/api/log';

// MediaPipe model URL (hosted on Google's CDN)
const HAND_LANDMARKER_MODEL_URL = 
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Hand landmark indices (MediaPipe hand model)
const THUMB_TIP_INDEX = 4;
const INDEX_FINGER_TIP_INDEX = 8;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate the 3D Euclidean distance between two landmarks
 * @param {Object} landmark1 - First landmark with x, y, z coordinates
 * @param {Object} landmark2 - Second landmark with x, y, z coordinates
 * @returns {number} - The 3D distance
 */
function calculate3DDistance(landmark1, landmark2) {
  const dx = landmark1.x - landmark2.x;
  const dy = landmark1.y - landmark2.y;
  const dz = landmark1.z - landmark2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Send pinch event to the backend server
 * @param {Object} coordinates - The 3D coordinates {x, y, z}
 */
async function logPinchToBackend(coordinates) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      coordinates: {
        x: coordinates.x,
        y: coordinates.y,
        z: coordinates.z
      }
    };

    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('Failed to log pinch:', response.statusText);
    }

    return payload;
  } catch (error) {
    console.error('Error sending pinch to backend:', error);
    return null;
  }
}

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================

function App() {
  // Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handLandmarkerRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastPinchTimeRef = useRef(0);
  const drawingUtilsRef = useRef(null);

  // State
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [currentDistance, setCurrentDistance] = useState(null);
  const [isPinching, setIsPinching] = useState(false);
  const [pinchCount, setPinchCount] = useState(0);
  const [recentLogs, setRecentLogs] = useState([]);
  const [handsDetected, setHandsDetected] = useState(0);

  // ============================================================================
  // MEDIAPIPE INITIALIZATION
  // ============================================================================

  const initializeHandLandmarker = useCallback(async () => {
    try {
      console.log('Initializing MediaPipe HandLandmarker...');
      
      // Initialize the vision fileset (use latest stable WASM bundle)
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
      );

      // Create the HandLandmarker
      const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: HAND_LANDMARKER_MODEL_URL,
          delegate: 'GPU' // Use GPU for better performance, falls back to CPU if unavailable
        },
        runningMode: 'VIDEO',
        numHands: 2, // Track up to 2 hands
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      handLandmarkerRef.current = handLandmarker;
      console.log('HandLandmarker initialized successfully');
      
      return handLandmarker;
    } catch (err) {
      console.error('Failed to initialize HandLandmarker:', err);
      throw err;
    }
  }, []);

  // ============================================================================
  // WEBCAM INITIALIZATION
  // ============================================================================

  const initializeWebcam = useCallback(async () => {
    try {
      console.log('Requesting webcam access...');
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        
        // Wait for video to be ready
        await new Promise((resolve) => {
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play();
            resolve();
          };
        });

        console.log('Webcam initialized successfully');
      }
    } catch (err) {
      console.error('Failed to access webcam:', err);
      throw new Error('Could not access webcam. Please ensure camera permissions are granted.');
    }
  }, []);

  // ============================================================================
  // HAND TRACKING LOOP
  // ============================================================================

  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const handLandmarker = handLandmarkerRef.current;

    if (!video || !canvas || !handLandmarker || video.readyState < 2) {
      animationFrameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const ctx = canvas.getContext('2d');
    
    // Set canvas dimensions to match video
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Detect hands in the current frame
    const startTimeMs = performance.now();
    const results = handLandmarker.detectForVideo(video, startTimeMs);

    // Update hands detected count
    setHandsDetected(results.landmarks?.length || 0);

    // Process each detected hand
    if (results.landmarks && results.landmarks.length > 0) {
      // Initialize drawing utils if not done
      if (!drawingUtilsRef.current) {
        drawingUtilsRef.current = new DrawingUtils(ctx);
      }

      for (let i = 0; i < results.landmarks.length; i++) {
        const landmarks = results.landmarks[i];
        const worldLandmarks = results.worldLandmarks?.[i];

        // Draw the hand landmarks and connections
        drawingUtilsRef.current.drawConnectors(
          landmarks,
          HandLandmarker.HAND_CONNECTIONS,
          { color: '#00FF00', lineWidth: 2 }
        );
        
        drawingUtilsRef.current.drawLandmarks(landmarks, {
          color: '#FF0000',
          lineWidth: 1,
          radius: 3
        });

        // Highlight thumb tip and index finger tip
        const thumbTip = landmarks[THUMB_TIP_INDEX];
        const indexTip = landmarks[INDEX_FINGER_TIP_INDEX];

        // Draw larger circles on thumb and index tips
        ctx.beginPath();
        ctx.arc(thumbTip.x * canvas.width, thumbTip.y * canvas.height, 8, 0, 2 * Math.PI);
        ctx.fillStyle = '#FFD700';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(indexTip.x * canvas.width, indexTip.y * canvas.height, 8, 0, 2 * Math.PI);
        ctx.fillStyle = '#00BFFF';
        ctx.fill();

        // Calculate distance between thumb and index finger
        // Use world landmarks (3D) if available, otherwise use normalized landmarks
        const thumbLandmark = worldLandmarks ? worldLandmarks[THUMB_TIP_INDEX] : thumbTip;
        const indexLandmark = worldLandmarks ? worldLandmarks[INDEX_FINGER_TIP_INDEX] : indexTip;
        
        const distance = calculate3DDistance(thumbLandmark, indexLandmark);
        setCurrentDistance(distance);

        // Check for pinch gesture
        const now = Date.now();
        const timeSinceLastPinch = now - lastPinchTimeRef.current;

        if (distance < PINCH_THRESHOLD && timeSinceLastPinch > DEBOUNCE_COOLDOWN_MS) {
          // PINCH DETECTED!
          lastPinchTimeRef.current = now;
          setIsPinching(true);
          setPinchCount(prev => prev + 1);

          // Draw a line between pinched fingers
          ctx.beginPath();
          ctx.moveTo(thumbTip.x * canvas.width, thumbTip.y * canvas.height);
          ctx.lineTo(indexTip.x * canvas.width, indexTip.y * canvas.height);
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 4;
          ctx.stroke();

          // Log to backend with index finger coordinates
          const logPayload = logPinchToBackend({
            x: indexLandmark.x,
            y: indexLandmark.y,
            z: indexLandmark.z
          });

          logPayload.then(payload => {
            if (payload) {
              setRecentLogs(prev => [
                `[${new Date().toLocaleTimeString()}] Pinch @ (${payload.coordinates.x.toFixed(4)}, ${payload.coordinates.y.toFixed(4)}, ${payload.coordinates.z.toFixed(4)})`,
                ...prev.slice(0, 9) // Keep last 10 logs
              ]);
            }
          });

          // Reset pinch visual after short delay
          setTimeout(() => setIsPinching(false), 200);
        }

        // Draw distance indicator line between thumb and index
        ctx.beginPath();
        ctx.moveTo(thumbTip.x * canvas.width, thumbTip.y * canvas.height);
        ctx.lineTo(indexTip.x * canvas.width, indexTip.y * canvas.height);
        ctx.strokeStyle = distance < PINCH_THRESHOLD ? '#FFD700' : 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      setCurrentDistance(null);
    }

    // Continue the loop
    animationFrameRef.current = requestAnimationFrame(processFrame);
  }, []);

  // ============================================================================
  // INITIALIZATION EFFECT
  // ============================================================================

  useEffect(() => {
    let isMounted = true;

    const initialize = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Initialize MediaPipe HandLandmarker
        await initializeHandLandmarker();

        // Initialize webcam
        await initializeWebcam();

        if (isMounted) {
          setIsLoading(false);
          setIsTracking(true);
          
          // Start the tracking loop
          animationFrameRef.current = requestAnimationFrame(processFrame);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || 'Failed to initialize');
          setIsLoading(false);
        }
      }
    };

    initialize();

    // Cleanup
    return () => {
      isMounted = false;
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      // Stop webcam
      if (videoRef.current?.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach(track => track.stop());
      }

      // Close HandLandmarker
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close();
      }
    };
  }, [initializeHandLandmarker, initializeWebcam, processFrame]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="app-container">
      <h1>🖐️ Hand Tracking - Pinch Detection</h1>
      <p className="subtitle">MediaPipe Tasks Vision • Security Research PoC</p>

      {/* Video/Canvas Container */}
      <div className="video-container">
        {isLoading && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Initializing MediaPipe...</p>
          </div>
        )}

        {error && (
          <div className="error">
            <p>⚠️ {error}</p>
            <p>Please refresh the page and grant camera permissions.</p>
          </div>
        )}

        <video
          ref={videoRef}
          playsInline
          muted
          style={{ display: isLoading || error ? 'none' : 'block' }}
        />
        
        <canvas
          ref={canvasRef}
          style={{ display: isLoading || error ? 'none' : 'block' }}
        />

        {isPinching && (
          <div className="pinch-indicator">✨ PINCH DETECTED!</div>
        )}
      </div>

      {/* Status Panel */}
      <div className="status-panel">
        <div className="status-row">
          <span className="status-label">Tracking Status</span>
          <span className={`status-value ${isTracking ? 'active' : 'inactive'}`}>
            {isTracking ? '● Active' : '○ Inactive'}
          </span>
        </div>
        
        <div className="status-row">
          <span className="status-label">Hands Detected</span>
          <span className="status-value">{handsDetected}</span>
        </div>

        <div className="status-row">
          <span className="status-label">Thumb-Index Distance</span>
          <span className={`status-value ${currentDistance !== null && currentDistance < PINCH_THRESHOLD ? 'pinch' : ''}`}>
            {currentDistance !== null ? currentDistance.toFixed(4) : 'N/A'}
          </span>
        </div>

        <div className="status-row">
          <span className="status-label">Pinch Threshold</span>
          <span className="status-value">{PINCH_THRESHOLD}</span>
        </div>

        <div className="status-row">
          <span className="status-label">Total Pinches Logged</span>
          <span className="status-value">{pinchCount}</span>
        </div>

        <div className="status-row">
          <span className="status-label">Debounce Cooldown</span>
          <span className="status-value">{DEBOUNCE_COOLDOWN_MS}ms</span>
        </div>
      </div>

      {/* Recent Logs */}
      {recentLogs.length > 0 && (
        <div className="log-section">
          <h3>📝 Recent Pinch Events</h3>
          <div className="log-list">
            {recentLogs.map((log, index) => (
              <div key={index} className="log-item">{log}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
