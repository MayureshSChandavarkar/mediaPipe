import subprocess
from flask import Flask, Response

app = Flask(__name__)

@app.route('/stream')
def stream():
    def generate():
        # Using a 1x1 pixel preview off-screen as a workaround because --nopreview breaks the encoder on your Pi OS!
        cmd = ["rpicam-vid", "--preview", "4000,4000,1,1", "-t", "0", "--codec", "mjpeg", "--width", "640", "--height", "480", "--framerate", "30", "--inline", "-o", "-"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        
        try:
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
        finally:
            # IMPORTANT: This ensures the camera is released when the stream stops!
            process.terminate()
            process.wait()

    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)