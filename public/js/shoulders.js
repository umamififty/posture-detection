// public/js/pose-detection.js

class PoseDetection {
    constructor() {
        // Initialize DOM element references
        this.videoElement = document.getElementById('poseVideoElement');
        this.canvasElement = document.getElementById('canvasElement');
        this.canvasCtx = this.canvasElement.getContext('2d');
        this.startButton = document.getElementById('startPoseButton');
        this.calibrateButton = document.getElementById('calibratePoseButton');
        this.shoulderStatus = document.getElementById('shoulderStatus');
        this.neckStatus = document.getElementById('neckStatus');
        this.postureRecommendation = document.getElementById('postureRecommendation');
        this.calibrationStatus = document.getElementById('poseCalibrationStatus');
        this.calibrationProgress = new mdc.linearProgress.MDCLinearProgress(
            document.getElementById('poseCalibrationProgress')
        );

        // Initialize buffers for smoothing readings
        this.shoulderAngleBuffer = [];
        this.neckAngleBuffer = [];
        this.bufferSize = 10;
        this.sensitivityMultiplier = 1.2;
        this.confidenceThreshold = 0.7;

        // Initialize the Pose model from MediaPipe
        this.pose = new Pose({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
            }
        });

        // Initialize state variables
        this.camera = null;
        this.calibratedShoulderAngle = null;
        this.calibratedNeckAngle = null;
        this.lastResults = null;
        
        // Notification state management
        this.lastShoulderNotification = 0;
        this.lastNeckNotification = 0;
        this.notificationCooldown = 30000; // 30 seconds between notifications
        
        // Animation frame ID for tracking/stopping rendering
        this.animationFrameId = null;

        // Set up the system
        this.setupEventListeners();
        this.setupPose();
        this.requestNotificationPermission();
    }

    // Request permission to show system notifications
    async requestNotificationPermission() {
        try {
            if (!("Notification" in window)) {
                console.log("This browser does not support notifications");
                return;
            }

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
        if (!("Notification" in window) || Notification.permission !== "granted") {
            return;
        }

        const now = Date.now();
        let lastNotification;

        if (type === 'shoulder') {
            lastNotification = this.lastShoulderNotification;
            this.lastShoulderNotification = now;
        } else if (type === 'neck') {
            lastNotification = this.lastNeckNotification;
            this.lastNeckNotification = now;
        }

        if (now - lastNotification < this.notificationCooldown) {
            return;
        }

        new Notification(title, {
            body: message,
            icon: '/path/to/your/icon.png',
            silent: false
        });
    }

    // Set up event listeners and Pose configuration
    setupEventListeners() {
        this.startButton.addEventListener('click', () => this.startCamera());
        this.calibrateButton.addEventListener('click', () => this.startCalibration());
    }
    
    // Setup pose estimation model
    setupPose() {
        this.pose.setOptions({
            modelComplexity: 1, // 0=Lite, 1=Full, 2=Heavy
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.pose.onResults((results) => this.onResults(results));
    }

    // Initialize and start the camera
    async startCamera() {
        this.camera = new Camera(this.videoElement, {
            onFrame: async () => {
                await this.pose.send({ image: this.videoElement });
            },
            width: 640,
            height: 480
        });
        
        await this.camera.start();
        this.startButton.disabled = true;
        this.calibrateButton.disabled = false;
    }

    // Calculate angle between three points
    calculateAngle(a, b, c) {
        // Convert to radians
        const radians = Math.atan2(c.y - b.y, c.x - b.x) - 
                        Math.atan2(a.y - b.y, a.x - b.x);
        
        // Convert to degrees
        let angle = Math.abs(radians * 180.0 / Math.PI);
        
        // Ensure angle is within 0-180 degrees
        if (angle > 180.0) angle = 360 - angle;
        
        return angle;
    }

    // Start the calibration process
    async startCalibration() {
        this.calibrateButton.disabled = true;
        this.calibrationStatus.textContent = 'Calibrating... Please sit in your ideal posture';
        this.calibrationProgress.determinate = true;
        this.calibrationProgress.progress = 0;

        // Arrays to store calibration measurements
        const shoulderAngles = [];
        const neckAngles = [];
        const totalFrames = 100;
        let currentFrame = 0;

        // Calibration interval
        const calibrationInterval = setInterval(() => {
            if (currentFrame >= totalFrames) {
                clearInterval(calibrationInterval);
                
                // Calculate average values from collected measurements
                this.calibratedShoulderAngle = shoulderAngles.reduce((a, b) => a + b) / shoulderAngles.length;
                this.calibratedNeckAngle = neckAngles.reduce((a, b) => a + b) / neckAngles.length;

                this.calibrationStatus.textContent = 'Calibration complete!';
                this.calibrateButton.disabled = false;
                this.calibrationProgress.progress = 1;
                
                console.log("Calibrated shoulder angle:", this.calibratedShoulderAngle);
                console.log("Calibrated neck angle:", this.calibratedNeckAngle);
                return;
            }

            if (this.lastResults && this.lastResults.poseLandmarks) {
                const landmarks = this.lastResults.poseLandmarks;
                
                // Check if key landmarks are visible with sufficient confidence
                if (this.checkLandmarksVisibility(landmarks)) {
                    // Calculate shoulder angle (left shoulder, right shoulder, right hip)
                    const shoulderAngle = this.calculateAngle(
                        landmarks[11], // Left shoulder
                        landmarks[12], // Right shoulder
                        landmarks[24]  // Right hip
                    );
                    
                    // Calculate neck angle (nose, mid-shoulders, mid-hips)
                    const midShoulder = {
                        x: (landmarks[11].x + landmarks[12].x) / 2,
                        y: (landmarks[11].y + landmarks[12].y) / 2
                    };
                    
                    const midHip = {
                        x: (landmarks[23].x + landmarks[24].x) / 2,
                        y: (landmarks[23].y + landmarks[24].y) / 2
                    };
                    
                    const neckAngle = this.calculateAngle(
                        landmarks[0],  // Nose
                        midShoulder,   // Mid-shoulders
                        midHip         // Mid-hips
                    );

                    shoulderAngles.push(shoulderAngle);
                    neckAngles.push(neckAngle);
                    currentFrame++;
                    this.calibrationProgress.progress = currentFrame / totalFrames;
                }
            }
        }, 30);
    }
    
    // Check if the required landmarks are visible with good confidence
    checkLandmarksVisibility(landmarks) {
        const keyPoints = [0, 11, 12, 23, 24]; // Nose, shoulders, hips
        return keyPoints.every(point => 
            landmarks[point] && 
            landmarks[point].visibility && 
            landmarks[point].visibility > this.confidenceThreshold);
    }

    // Process detection results and draw landmarks
    onResults(results) {
        this.lastResults = results;
        
        // Clear canvas and draw the pose landmarks if available
        this.canvasCtx.save();
        this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
        
        if (results.poseLandmarks) {
            // Draw pose landmarks with connectors
            drawConnectors(this.canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, 
                { color: '#8ab4f8', lineWidth: 4 });
            drawLandmarks(this.canvasCtx, results.poseLandmarks, 
                { color: '#f8c471', lineWidth: 2 });
                
            // Check posture if calibrated
            if (this.calibratedShoulderAngle && this.calibratedNeckAngle) {
                this.checkPosture(results);
            }
        }
        
        this.canvasCtx.restore();
    }
    
    // Check posture and provide feedback
    checkPosture(results) {
        if (!results.poseLandmarks) return;
        
        const landmarks = results.poseLandmarks;
        
        // Check if key landmarks are visible with sufficient confidence
        if (this.checkLandmarksVisibility(landmarks)) {
            // Calculate current shoulder angle
            const currentShoulderAngle = this.calculateAngle(
                landmarks[11], // Left shoulder
                landmarks[12], // Right shoulder
                landmarks[24]  // Right hip
            );
            
            // Calculate current neck angle
            const midShoulder = {
                x: (landmarks[11].x + landmarks[12].x) / 2,
                y: (landmarks[11].y + landmarks[12].y) / 2
            };
            
            const midHip = {
                x: (landmarks[23].x + landmarks[24].x) / 2,
                y: (landmarks[23].y + landmarks[24].y) / 2
            };
            
            const currentNeckAngle = this.calculateAngle(
                landmarks[0],  // Nose
                midShoulder,   // Mid-shoulders
                midHip         // Mid-hips
            );
            
            // Add to buffer for smoothing
            this.shoulderAngleBuffer.push(currentShoulderAngle);
            if (this.shoulderAngleBuffer.length > this.bufferSize) {
                this.shoulderAngleBuffer.shift();
            }
            
            this.neckAngleBuffer.push(currentNeckAngle);
            if (this.neckAngleBuffer.length > this.bufferSize) {
                this.neckAngleBuffer.shift();
            }
            
            // Get smoothed angles
            const smoothedShoulderAngle = this.shoulderAngleBuffer.reduce((a, b) => a + b) / this.shoulderAngleBuffer.length;
            const smoothedNeckAngle = this.neckAngleBuffer.reduce((a, b) => a + b) / this.neckAngleBuffer.length;
            
            // Check shoulder posture
            let shoulderStatus = '';
            let shoulderDeviation = Math.abs(smoothedShoulderAngle - this.calibratedShoulderAngle);
            let shoulderThreshold = 10 * this.sensitivityMultiplier;
            
            if (shoulderDeviation > shoulderThreshold) {
                if (smoothedShoulderAngle > this.calibratedShoulderAngle) {
                    shoulderStatus = 'Shoulders are hunched forward';
                    this.shoulderStatus.textContent = shoulderStatus;
                    this.shoulderStatus.style.color = 'red';
                    this.sendNotification('Posture Alert', 'Your shoulders are hunched forward', 'shoulder');
                } else {
                    shoulderStatus = 'Shoulders are too far back';
                    this.shoulderStatus.textContent = shoulderStatus;
                    this.shoulderStatus.style.color = 'orange';
                    this.sendNotification('Posture Alert', 'Your shoulders are too far back', 'shoulder');
                }
            } else {
                shoulderStatus = 'Shoulder posture is good';
                this.shoulderStatus.textContent = shoulderStatus;
                this.shoulderStatus.style.color = 'green';
            }
            
            // Check neck posture
            let neckStatus = '';
            let neckDeviation = Math.abs(smoothedNeckAngle - this.calibratedNeckAngle);
            let neckThreshold = 15 * this.sensitivityMultiplier;
            
            if (neckDeviation > neckThreshold) {
                if (smoothedNeckAngle < this.calibratedNeckAngle) {
                    neckStatus = 'Your head is too far forward';
                    this.neckStatus.textContent = neckStatus;
                    this.neckStatus.style.color = 'red';
                    this.sendNotification('Posture Alert', 'Your head is too far forward', 'neck');
                } else {
                    neckStatus = 'Your head is too far back';
                    this.neckStatus.textContent = neckStatus;
                    this.neckStatus.style.color = 'orange';
                    this.sendNotification('Posture Alert', 'Your head is too far back', 'neck');
                }
            } else {
                neckStatus = 'Neck posture is good';
                this.neckStatus.textContent = neckStatus;
                this.neckStatus.style.color = 'green';
            }
            
            // Provide recommendations based on posture issues
            this.updateRecommendations(shoulderStatus, neckStatus);
            
            // Log the current angles for debugging
            console.log("Current shoulder angle:", smoothedShoulderAngle, 
                        "Calibrated:", this.calibratedShoulderAngle, 
                        "Deviation:", shoulderDeviation);
            console.log("Current neck angle:", smoothedNeckAngle, 
                        "Calibrated:", this.calibratedNeckAngle, 
                        "Deviation:", neckDeviation);
        }
    }
    
    // Update recommendation text based on current posture status
    updateRecommendations(shoulderStatus, neckStatus) {
        let recommendation = '';
        
        if (shoulderStatus.includes('hunched')) {
            recommendation += 'Roll your shoulders back and down. Imagine pulling your shoulder blades together and down. ';
        } else if (shoulderStatus.includes('too far back')) {
            recommendation += 'Relax your shoulders slightly forward. Don\'t overextend backward. ';
        }
        
        if (neckStatus.includes('too far forward')) {
            recommendation += 'Gently pull your chin back to align your ears with your shoulders. Think "neck back, not up". ';
        } else if (neckStatus.includes('too far back')) {
            recommendation += 'Bring your head to a neutral position, not tilted back. Look straight ahead. ';
        }
        
        if (recommendation === '') {
            recommendation = 'Great job! Maintain your current posture.';
        } else {
            recommendation += 'Take a short break to stretch if needed.';
        }
        
        this.postureRecommendation.textContent = recommendation;
    }
    
    // Stop camera and pose detection
    stop() {
        if (this.camera) {
            this.camera.stop();
        }
        
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        this.startButton.disabled = false;
        this.calibrateButton.disabled = true;
    }
    
    // Reset all calibration data
    reset() {
        this.calibratedShoulderAngle = null;
        this.calibratedNeckAngle = null;
        this.shoulderAngleBuffer = [];
        this.neckAngleBuffer = [];
        this.shoulderStatus.textContent = 'Not calibrated';
        this.shoulderStatus.style.color = 'black';
        this.neckStatus.textContent = 'Not calibrated';
        this.neckStatus.style.color = 'black';
        this.postureRecommendation.textContent = '';
        this.calibrationStatus.textContent = 'Not calibrated';
        this.calibrationProgress.progress = 0;
    }
}

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    const poseDetection = new PoseDetection();
    
    // Add stop button functionality if needed
    const stopButton = document.getElementById('stopPoseButton');
    if (stopButton) {
        stopButton.addEventListener('click', () => poseDetection.stop());
    }
    
    // Add reset button functionality if needed
    const resetButton = document.getElementById('resetPoseButton');
    if (resetButton) {
        resetButton.addEventListener('click', () => poseDetection.reset());
    }
});