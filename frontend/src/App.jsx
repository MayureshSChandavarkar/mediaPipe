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

// Virtual Keypad Setup
const KEYPAD_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#']
];

// 3D coordinates for the VR Keyboard in normalized space
// Z represents depth (away from the camera). Positive is further away.
const VIRTUAL_KEYPAD_Z = 0.4; // Moved closer to shorten the ray (was 1.5)
const KEYPAD_3D_WIDTH = 0.5;
const KEYPAD_3D_HEIGHT = 0.6;
const KEYPAD_3D_START_X = 0.5 - (KEYPAD_3D_WIDTH / 2);
const KEYPAD_3D_START_Y = 0.5 - (KEYPAD_3D_HEIGHT / 2);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Maps a 3D intersection point to a key on the virtual keypad.
 * Returns the key string if pressed, or null if outside.
 */
function predictKeyFrom3DHit(x, y) {
  if (x < KEYPAD_3D_START_X || x > KEYPAD_3D_START_X + KEYPAD_3D_WIDTH || y < KEYPAD_3D_START_Y || y > KEYPAD_3D_START_Y + KEYPAD_3D_HEIGHT) return null;
  
  const col = Math.floor((x - KEYPAD_3D_START_X) / (KEYPAD_3D_WIDTH / 3));
  const row = Math.floor((y - KEYPAD_3D_START_Y) / (KEYPAD_3D_HEIGHT / 4));
  
  if (row >= 0 && row < 4 && col >= 0 && col < 3) {
    return KEYPAD_LAYOUT[row][col];
  }
  return null;
}

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
 * @param {string} key - The predicted key
 * @param {Object} coordinates - The 3D coordinates {x, y, z}
 */
async function logPinchToBackend(key, coordinates) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      keyPredicted: key,
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
  const imgRef = useRef(null); // For handling the Raspberry Pi MJPEG image stream
  const canvasRef = useRef(null);
  const handLandmarkerRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastPinchTimeRef = useRef(0);
  const drawingUtilsRef = useRef(null);

  // State
  const [streamMode, setStreamMode] = useState('pi'); // 'pi' or 'webcam'
  const [piUrl, setPiUrl] = useState('/pi-stream');
  
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
      console.log('Step 1: Loading MediaPipe WASM files...');
      
      // Initialize the vision fileset (use latest stable WASM bundle)
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
      );
      console.log('Step 2: WASM loaded, creating HandLandmarker...');

      // Create the HandLandmarker - try CPU first for compatibility
      const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: HAND_LANDMARKER_MODEL_URL,
          delegate: 'CPU' // Use CPU for better compatibility
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      handLandmarkerRef.current = handLandmarker;
      console.log('Step 3: HandLandmarker ready!');
      
      return handLandmarker;
    } catch (err) {
      console.error('Failed to initialize HandLandmarker:', err);
      throw new Error(`MediaPipe init failed: ${err.message}`);
    }
  }, []);

  // ============================================================================
  // MEDIA STREAM INITIALIZATION
  // ============================================================================

  const startMediaStream = useCallback(async () => {
    try {
      if (streamMode === 'webcam') {
        console.log('Step 4: Requesting webcam access...');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia not supported - try Chrome or Firefox');
        }
        
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user'
          }
        });
        console.log('Step 5: Camera permission granted');

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Video load timeout')), 10000);
            videoRef.current.onloadedmetadata = () => {
              clearTimeout(timeout);
              videoRef.current.play();
              console.log('Step 6: Video playing!');
              resolve();
            };
            videoRef.current.onerror = () => {
              clearTimeout(timeout);
              reject(new Error('Video element error'));
            };
          });
        }
      } else if (streamMode === 'pi') {
        console.log(`Step 4: Connecting to Pi Stream at ${piUrl}...`);
        
        if (imgRef.current) {
          // No crossOrigin needed since we are actively proxying it through Vite!
          imgRef.current.src = piUrl;

          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              clearInterval(checker);
              reject(new Error('Pi Stream connection timeout. Check IP and port.'));
            }, 10000);
            
            // browsers sometimes don't fire "onload" for continuous MJPEG streams, 
            // so we constantly pole the image to see if it received its first frame!
            const checker = setInterval(() => {
              if (imgRef.current && imgRef.current.naturalWidth > 0) {
                clearInterval(checker);
                clearTimeout(timeout);
                console.log('Step 5: Pi Stream connected!');
                resolve();
              }
            }, 100);

            imgRef.current.onerror = () => {
              clearTimeout(timeout);
              reject(new Error('Failed to connect to Pi Stream. Ensure mjpg-streamer is running on the Pi.'));
            };
          });
        }
      }
    } catch (err) {
      console.error('Media stream error:', err);
      throw new Error(`Media connection failed: ${err.message}`);
    }
  }, [streamMode, piUrl]);

  // ============================================================================
  // HAND TRACKING LOOP
  // ============================================================================

  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const handLandmarker = handLandmarkerRef.current;
    
    // Choose active media element
    const activeMedia = streamMode === 'webcam' ? video : img;

    if (!activeMedia || !canvas || !handLandmarker) {
      animationFrameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // Check media readiness
    let mediaWidth = 0;
    let mediaHeight = 0;
    if (streamMode === 'webcam' && video.readyState >= 2) {
      mediaWidth = video.videoWidth;
      mediaHeight = video.videoHeight;
    } else if (streamMode === 'pi' && img.complete && img.naturalWidth > 0) {
      mediaWidth = img.naturalWidth;
      mediaHeight = img.naturalHeight;
    } else {
      animationFrameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const ctx = canvas.getContext('2d');
    
    // Set canvas dimensions to match video/stream
    if (canvas.width !== mediaWidth || canvas.height !== mediaHeight) {
      canvas.width = mediaWidth;
      canvas.height = mediaHeight;
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // --- DRAW VIRTUAL SPATIAL KEYPAD IN 3D PERSPECTIVE ---
    // Simulate a 3D perspective by mathematically projecting the keypad corners
    // and drawing a holographic grid in the center of the screen
    const fov = 400; // Perspective zoom
    
    // Project a 3D point (px, py, pz) to 2D canvas (x, y)
    const project3D = (px, py, pz) => {
      // Shift origin to center for perspective calculation
      const cx = px - 0.5;
      const cy = py - 0.5;
      
      const scale = fov / (fov + pz * 600);
      return {
        x: (cx * scale + 0.5) * canvas.width,
        y: (cy * scale + 0.5) * canvas.height,
        scale: scale
      };
    };

    // Draw the keypad cells with holographic VR style
    KEYPAD_LAYOUT.forEach((row, r) => {
      row.forEach((key, c) => {
        const cellW = KEYPAD_3D_WIDTH / 3;
        const cellH = KEYPAD_3D_HEIGHT / 4;
        
        const cellX = KEYPAD_3D_START_X + (c * cellW);
        const cellY = KEYPAD_3D_START_Y + (r * cellH);
        
        // Find 4 corners in 3D
        const pTL = project3D(cellX, cellY, VIRTUAL_KEYPAD_Z);
        const pTR = project3D(cellX + cellW, cellY, VIRTUAL_KEYPAD_Z);
        const pBL = project3D(cellX, cellY + cellH, VIRTUAL_KEYPAD_Z);
        const pBR = project3D(cellX + cellW, cellY + cellH, VIRTUAL_KEYPAD_Z);

        // Draw the warped poly for this cell
        ctx.beginPath();
        ctx.moveTo(pTL.x, pTL.y);
        ctx.lineTo(pTR.x, pTR.y);
        ctx.lineTo(pBR.x, pBR.y);
        ctx.lineTo(pBL.x, pBL.y);
        ctx.closePath();
        
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.4)';
        ctx.fillStyle = 'rgba(25, 25, 35, 0.5)';
        ctx.fill();
        ctx.stroke();
        
        // Draw the text in the center
        const center = project3D(cellX + cellW/2, cellY + cellH/2, VIRTUAL_KEYPAD_Z);
        ctx.font = `${24 * center.scale}px monospace`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(key, center.x, center.y);
      });
    });

    // Detect hands in the current frame
    const startTimeMs = performance.now();
    const results = handLandmarker.detectForVideo(activeMedia, startTimeMs);

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

        // Calculate ray from WRIST (0) to INDEX_FINGER_TIP (8) in 3D
        const wrist = landmarks[0];
        const dx = indexTip.x - wrist.x;
        const dy = indexTip.y - wrist.y;
        // In MediaPipe normalized landmarks, z is pseudo-depth (roughly proportional to width)
        const dz = indexTip.z - wrist.z;
        
        // Ray equation: HandStart + t * Direction = PointOnPlane
        // We know the plane is at Z = VIRTUAL_KEYPAD_Z.
        // We want to find 't' where: wrist.z + t * dz = VIRTUAL_KEYPAD_Z
        // If dz is 0, line is parallel to plane.
        let hitX = null, hitY = null, pCursor = null;
        
        if (Math.abs(dz) > 0.0001) {
          const t = (VIRTUAL_KEYPAD_Z - wrist.z) / dz;
          
          // Only render intersect if pointing forward (t > 0)
          if (t > 0) {
            hitX = wrist.x + t * dx;
            hitY = wrist.y + t * dy;
            
            // Project the 3D hit point back to the 2D canvas 
            pCursor = project3D(hitX, hitY, VIRTUAL_KEYPAD_Z);
            
            // Draw the laser beam from index tip to the 3D plane
            ctx.beginPath();
            ctx.moveTo(indexTip.x * canvas.width, indexTip.y * canvas.height);
            ctx.lineTo(pCursor.x, pCursor.y);
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw laser cursor pointer on the HUD
            ctx.beginPath();
            ctx.arc(pCursor.x, pCursor.y, 6 * pCursor.scale, 0, 2*Math.PI);
            ctx.fillStyle = '#00FF00';
            ctx.fill();
          }
        }

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

          // We check the 3D intersection of the laser against the keypad plane!
          let pressedKey = null;
          if (hitX !== null && hitY !== null && pCursor !== null) {
            pressedKey = predictKeyFrom3DHit(hitX, hitY);

            // Draw 3D visual ping at laser hit location on the plane
            ctx.beginPath();
            ctx.arc(pCursor.x, pCursor.y, 25 * pCursor.scale, 0, 2*Math.PI);
            ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
            ctx.fill();
          }

          // Log to backend with index finger coordinates
          const logPayload = logPinchToBackend(pressedKey || 'MISS', {
            x: indexLandmark.x,
            y: indexLandmark.y,
            z: indexLandmark.z
          });

          logPayload.then(payload => {
            if (payload) {
              setRecentLogs(prev => [
                `[${new Date().toLocaleTimeString()}] Typed [${payload.keyPredicted}] @ (${payload.coordinates.x.toFixed(4)}, ${payload.coordinates.y.toFixed(4)}, ${payload.coordinates.z.toFixed(4)})`,
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
  }, [streamMode]);

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

        // Initialize webcam or Pi stream
        await startMediaStream();

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

      // Stop webcam and clear media references
      if (videoRef.current?.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      
      if (imgRef.current) {
        imgRef.current.src = "";
      }

      // Close HandLandmarker
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close();
      }
    };
  }, [initializeHandLandmarker, startMediaStream, processFrame]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="app-container">
      <h1>🖐️ Hand Tracking - Pinch Detection</h1>
      <p className="subtitle">MediaPipe Tasks Vision • GoPro/Security Research PoC</p>

      {/* Stream Controls */}
      <div className="stream-controls" style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <select 
          value={streamMode} 
          onChange={(e) => setStreamMode(e.target.value)}
          disabled={isLoading}
        >
          <option value="webcam">Local Webcam</option>
          <option value="pi">Raspberry Pi (GoPro Mode)</option>
        </select>
        
        {streamMode === 'pi' && (
          <input 
            type="text" 
            value={piUrl} 
            onChange={(e) => setPiUrl(e.target.value)}
            disabled={isLoading}
            placeholder="/pi-stream"
            style={{ width: '300px' }}
          />
        )}
      </div>

      {/* Video/Canvas Container */}
      <div className={`video-container ${streamMode === 'webcam' ? 'mirrored' : ''}`}>
        {isLoading && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Initializing MediaPipe...</p>
          </div>
        )}

        {error && (
          <div className="error">
            <p>⚠️ {error}</p>
            <p>Please check your connection and refresh.</p>
          </div>
        )}

        <video
          ref={videoRef}
          playsInline
          muted
          style={{ display: isLoading || error || streamMode !== 'webcam' ? 'none' : 'block' }}
        />
        
        <img
          ref={imgRef}
          alt="Pi Stream"
          style={{ display: isLoading || error || streamMode !== 'pi' ? 'none' : 'block' }}
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
