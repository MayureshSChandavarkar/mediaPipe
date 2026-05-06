rpicam-vid -t 0 --width 1280 --height 720 --framerate 30 -o null
./mjpg_streamer -i "./input_uvc.so -d /dev/video0 -r 640x480 -f 30" -o "./output_http.so -w ./www -p 8080"