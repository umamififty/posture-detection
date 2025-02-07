// public/js/app.js

class PostureDetection {
    constructor() {
        // Initialize DOM element references for the UI components
        this.videoElement = document.getElementById('videoElement');
        this.startButton = document.getElementById('startButton');
        this.calibrateButton = document.getElementById('calibrateButton');
        this.headStatus = document.getElementById('headStatus');
        this.mouthStatus = document.getElementById('mouthStatus');
        this.calibrationStatus = document.getElementById('calibrationStatus');
        this.calibrationProgress = new mdc.linearProgress.MDCLinearProgress(
            document.getElementById('calibrationProgress')
        );
        this.headAngleBuffer = [];
        this.bufferSize = 5;
        this.sensitivityMultiplier = 1.2;
        this.confidenceThreshold = 0.7;

        // Initialize the FaceMesh model from MediaPipe
        this.faceMesh = new FaceMesh({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
            }
        });

        // Initialize state variables
        this.camera = null;                    // Camera instance
        this.calibratedAngle = null;           // Reference angle for head position
        this.calibratedMouthDistance = null;   // Reference distance for mouth opening
        this.mouthOpenStartTime = null;        // Timestamp when mouth opened
        this.lastResults = null;               // Store the latest detection results

        // Notification state management
        this.lastHeadNotification = 0;         // Timestamp of last head position alert
        this.lastMouthNotification = 0;        // Timestamp of last mouth position alert
        this.notificationCooldown = 30000;     // 30 seconds between notifications

        // Set up the system
        this.setupEventListeners();
        this.requestNotificationPermission();
    }

    // Request permission to show system notifications
    async requestNotificationPermission() {
        try {
            // Check browser support for notifications
            if (!("Notification" in window)) {
                console.log("This browser does not support notifications");
                return;
            }

            // Request permission from user
            const permission = await Notification.requestPermission();
            if (permission === "granted") {
                console.log("Notification permission granted");
            } else {
                console.log("Notification permission denied");
            }
        } catch (error) {
            console.error("Error requesting notification permission:", error);
        }
    }

    // Send a notification with cooldown prevention
    sendNotification(title, message, type) {
        // Verify notification support and permissions
        if (!("Notification" in window) || Notification.permission !== "granted") {
            return;
        }

        const now = Date.now();
        let lastNotification;

        // Check notification type and update appropriate timestamp
        if (type === 'head') {
            lastNotification = this.lastHeadNotification;
            this.lastHeadNotification = now;
        } else if (type === 'mouth') {
            lastNotification = this.lastMouthNotification;
            this.lastMouthNotification = now;
        }

        // Prevent notification spam by checking cooldown period
        if (now - lastNotification < this.notificationCooldown) {
            return;
        }

        // Create and display the notification
        new Notification(title, {
            body: message,
            icon: '/path/to/your/icon.png', // You can add your own icon path here
            silent: false
        });
    }

    // Set up event listeners and FaceMesh configuration
    setupEventListeners() {
        this.startButton.addEventListener('click', () => this.startCamera());
        this.calibrateButton.addEventListener('click', () => this.startCalibration());

        // Configure FaceMesh settings
        this.faceMesh.setOptions({
            maxNumFaces: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.faceMesh.onResults(results => this.onResults(results));
    }

    // Initialize and start the camera
    async startCamera() {
        this.camera = new Camera(this.videoElement, {
            onFrame: async () => {
                await this.faceMesh.send({ image: this.videoElement });
            },
            width: 640,
            height: 480
        });
        await this.camera.start();
        this.startButton.disabled = true;
        this.calibrateButton.disabled = false;
    }

    // Calculate angle between three points (used for head position)
    calculateAngle(a, b, c) {
        const radians = Math.atan2(c.y - b.y, c.x - b.x) -
            Math.atan2(a.y - b.y, a.x - b.x);
        let angle = Math.abs(radians * 180.0 / Math.PI);
        if (angle > 180.0) angle = 360 - angle;
        return angle;
    }

    // Calculate distance between two points (used for mouth measurements)
    calculateDistance(point1, point2) {
        return Math.sqrt(
            Math.pow(point1.x - point2.x, 2) +
            Math.pow(point1.y - point2.y, 2)
        );
    }

    // Start the calibration process
    async startCalibration() {
        this.calibrateButton.disabled = true;
        this.calibrationStatus.textContent = 'Calibrating... Please look straight ahead';
        this.calibrationProgress.determinate = true;
        this.calibrationProgress.progress = 0;

        // Arrays to store calibration measurements
        const angles = [];
        const mouthDistances = [];
        const totalFrames = 100;
        let currentFrame = 0;

        // Calibration interval
        const calibrationInterval = setInterval(() => {
            if (currentFrame >= totalFrames) {
                clearInterval(calibrationInterval);
                // Calculate average values from collected measurements
                this.calibratedAngle = angles.reduce((a, b) => a + b) / angles.length;
                this.calibratedMouthDistance = mouthDistances.reduce((a, b) => a + b) / mouthDistances.length;

                this.calibrationStatus.textContent = 'Calibration complete!';
                this.calibrateButton.disabled = false;
                this.calibrationProgress.progress = 1;
                return;
            }

            if (this.lastResults && this.lastResults.multiFaceLandmarks) {
                const landmarks = this.lastResults.multiFaceLandmarks[0];
                const angle = this.calculateAngle(
                    landmarks[33],  // Left eye
                    landmarks[4],   // Nose tip
                    landmarks[263]  // Right eye
                );
                const mouthDistance = this.calculateDistance(
                    landmarks[13],  // Upper lip
                    landmarks[14]   // Lower lip
                );

                angles.push(angle);
                mouthDistances.push(mouthDistance);
                currentFrame++;
                this.calibrationProgress.progress = currentFrame / totalFrames;
            }
        }, 30);
    }

    async checkPosture(results) {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            const landmarks = results.multiFaceLandmarks[0];
            
            // Calculate head angle with increased precision
            const currentAngle = this.calculateHeadAngle(landmarks);
            
            // Add to buffer for smoothing
            this.headAngleBuffer.push(currentAngle);
            if (this.headAngleBuffer.length > this.bufferSize) {
                this.headAngleBuffer.shift();
            }
            
            // Get smoothed angle
            const smoothedAngle = this.headAngleBuffer.reduce((a, b) => a + b) / this.headAngleBuffer.length;
            
            // Check if head position exceeds threshold with sensitivity multiplier
            if (smoothedAngle > this.calibratedAngle * this.sensitivityMultiplier && 
                landmarks[1].visibility > this.confidenceThreshold) {
                this.headStatus.textContent = 'Head Position: Poor - Please correct your posture';
                this.headStatus.style.color = 'red';
                
                this.sendNotification(
                    'Poor Posture Detected',
                    'Your head is dropping. Please correct your posture.',
                    'head'
                );
            } else {
                this.headStatus.textContent = 'Head Position: Good';
                this.headStatus.style.color = 'green';
            }
        }
    }


    // Process detection results and trigger notifications
    onResults(results) {
        this.lastResults = results;

        if (results.multiFaceLandmarks && this.calibratedAngle) {
            const landmarks = results.multiFaceLandmarks[0];
            const angle = this.calculateAngle(
                landmarks[33],  // Left eye
                landmarks[4],   // Nose tip
                landmarks[263]  // Right eye
            );
            const mouthDistance = this.calculateDistance(
                landmarks[13],  // Upper lip
                landmarks[14]   // Lower lip
            );

            // Head position detection and notification
            if (angle < this.calibratedAngle - 15) {
                this.headStatus.textContent = 'Head Position: Dropping! Please correct your posture';
                this.headStatus.style.color = 'red';

                this.sendNotification(
                    'Poor Posture Detected',
                    'Your head is dropping. Please correct your posture.',
                    'head'
                );
            } else {
                this.headStatus.textContent = 'Head Position: Good';
                this.headStatus.style.color = 'green';
            }

            // Mouth position detection and notification
            if (mouthDistance > this.calibratedMouthDistance * 1.5) {
                if (!this.mouthOpenStartTime) {
                    this.mouthOpenStartTime = Date.now();
                } else if (Date.now() - this.mouthOpenStartTime > 5000) {
                    this.mouthStatus.textContent = 'Mouth: Open for too long!';
                    this.mouthStatus.style.color = 'red';

                    this.sendNotification(
                        'Mouth Open Alert',
                        'Your mouth has been open for too long.',
                        'mouth'
                    );
                }
            } else {
                this.mouthOpenStartTime = null;
                this.mouthStatus.textContent = 'Mouth: Normal';
                this.mouthStatus.style.color = 'green';
            }
        }
    }
}

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new PostureDetection();
});