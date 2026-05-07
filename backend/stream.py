import subprocess
from flask import Flask, Response

app = Flask(__name__)

@app.route('/stream')
def stream():
    def generate():
        # Using 1280x720 natively zooms the camera out because it uses the full frame of the sensor!
        cmd = ["rpicam-vid", "-t", "0", "--codec", "mjpeg", "--width", "1280", "--height", "720", "--framerate", "30", "--inline", "-o", "-"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        
        chunk = b''
        while True:
            data = process.stdout.read(4096)
            if not data:
                break
            chunk += data
            a = chunk.find(b'\xff\xd8')
            b = chunk.find(b'\xff\xd9')
            if a != -1 and b != -1:
                jpg = chunk[a:b+2]
                chunk = chunk[b+2:]
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + jpg + b'\r\n')

    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)