// public/js/shoulders.js

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
        
        // Posture threshold detection settings
        this.shoulderThreshold = 10;
        this.neckThreshold = 15;
        this.postureDropDuration = 2000; // Time in milliseconds to trigger alert (2 seconds)
        this.postureDropStartTime = null; // Timestamp when poor posture started
        this.isPoorPosture = false;

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
        this.notificationCooldown = 10000; // 10 seconds between notifications
        this.notificationsEnabled = false;
        
        // Background mode variables
        this.isBackgroundMonitoringEnabled = false;
        this.backgroundInterval = null;
        this.backgroundAnalysisActive = false;
        this.lastProcessedFrame = null;
        
        // Animation frame ID for tracking/stopping rendering
        this.animationFrameId = null;

        // Set up the system
        this.setupEventListeners();
        this.setupPose();
    }

    // Request permission to show system notifications
    async enableNotifications() {
        try {
            // Check browser support for notifications
            if (!("Notification" in window)) {
                console.log("This browser does not support notifications");
                return false;
            }

            // Request permission from user
            const permission = await Notification.requestPermission();
            if (permission === "granted") {
                console.log("Notification permission granted");
                this.notificationsEnabled = true;
                
                // Show test notification
                new Notification("Posture Detection Notifications Enabled", {
                    body: "You will now receive alerts when your posture needs correction.",
                    silent: false
                });
                
                return true;
            } else {
                console.log("Notification permission denied");
                return false;
            }
        } catch (error) {
            console.error("Error requesting notification permission:", error);
            return false;
        }
    }

    // Send a notification with cooldown prevention
    sendNotification(title, message, type) {
        // Check if notifications are enabled
        if (!this.notificationsEnabled) {
            console.log("Notifications not enabled. Requesting permission...");
            this.enableNotifications();
            return;
        }
        
        // Verify notification support and permissions
        if (!("Notification" in window) || Notification.permission !== "granted") {
            console.log("Notification permission not granted");
            return;
        }

        const now = Date.now();
        
        // Check notification type and update appropriate timestamp
        if (type === 'shoulder') {
            // Check cooldown period
            if (now - this.lastShoulderNotification < this.notificationCooldown) {
                console.log("Shoulder notification on cooldown");
                return; // Still in cooldown period
            }
            this.lastShoulderNotification = now;
        } else if (type === 'neck') {
            // Check cooldown period
            if (now - this.lastNeckNotification < this.notificationCooldown) {
                console.log("Neck notification on cooldown");
                return; // Still in cooldown period
            }
            this.lastNeckNotification = now;
        }

        // Create and display the notification
        try {
            const notification = new Notification(title, {
                body: message,
                icon: 'https://icon-library.com/images/posture-icon/posture-icon-29.jpg', // Same icon as face detection
                requireInteraction: false, // Auto-dismiss after browser default time
                silent: false // Play sound for attention
            });
            
            // Log for debugging
            console.log(`${type.toUpperCase()} NOTIFICATION SENT: ${title} - ${message}`);
            
            // Set timeout to close notification after 5 seconds
            setTimeout(() => {
                notification.close();
            }, 5000);
            
        } catch (error) {
            console.error("Error sending notification:", error);
        }
    }

    // Set up event listeners and Pose configuration
    setupEventListeners() {
        this.startButton.addEventListener('click', async () => {
            // Request notification permission when starting camera
            await this.enableNotifications();
            this.startCamera();
        });
        
        this.calibrateButton.addEventListener('click', () => this.startCalibration());
        
        // Add background monitoring toggle button
        const backgroundButton = document.createElement('button');
        backgroundButton.id = 'poseBackgroundButton';
        backgroundButton.className = 'mdc-button';
        backgroundButton.innerHTML = '<span class="mdc-button__label">Enable Background Monitoring</span>';
        backgroundButton.disabled = true;
        
        // Insert the button after calibrate button
        this.calibrateButton.parentNode.insertBefore(backgroundButton, this.calibrateButton.nextSibling);
        this.backgroundButton = backgroundButton;
        
        // Add event listener for background monitoring
        this.backgroundButton.addEventListener('click', () => {
            if (this.isBackgroundMonitoringEnabled) {
                this.disableBackgroundMonitoring();
                this.backgroundButton.querySelector('.mdc-button__label').textContent = 'Enable Background Monitoring';
            } else {
                this.enableBackgroundMonitoring();
                this.backgroundButton.querySelector('.mdc-button__label').textContent = 'Disable Background Monitoring';
            }
        });
        
        // Register for visibility change events
        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    }
    
    // Handle page visibility changes
    handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            console.log('Page is now hidden, continuing monitoring in background mode');
            if (this.isBackgroundMonitoringEnabled) {
                this.startBackgroundCapture();
            }
        } else {
            console.log('Page is now visible, switching to foreground mode');
            if (this.isBackgroundMonitoringEnabled) {
                this.stopBackgroundCapture();
            }
        }
    }
    
    // Enable background monitoring capability
    enableBackgroundMonitoring() {
        if (this.calibratedShoulderAngle === null || this.calibratedNeckAngle === null) {
            alert('Please calibrate your posture first');
            return;
        }
        
        this.isBackgroundMonitoringEnabled = true;
        console.log('Background monitoring enabled');
        
        // Store calibration data in localStorage
        this.saveCalibrationData();
        
        // Start background monitoring if page is already hidden
        if (document.visibilityState === 'hidden') {
            this.startBackgroundCapture();
        }
        
        // Request persistent storage permission
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(isPersisted => {
                console.log(`Storage persistence is ${isPersisted ? 'enabled' : 'not enabled'}`);
            });
        }
        
        this.sendNotification(
            'Background Monitoring Enabled',
            'Posture detection will continue even when this tab is not active.',
            'shoulder'
        );
    }
    
    // Disable background monitoring
    disableBackgroundMonitoring() {
        this.isBackgroundMonitoringEnabled = false;
        this.stopBackgroundCapture();
        console.log('Background monitoring disabled');
    }
    
    // Save calibration data to localStorage
    saveCalibrationData() {
        const calibrationData = {
            calibratedShoulderAngle: this.calibratedShoulderAngle,
            calibratedNeckAngle: this.calibratedNeckAngle,
            shoulderThreshold: this.shoulderThreshold,
            neckThreshold: this.neckThreshold,
            lastUpdated: Date.now()
        };
        
        localStorage.setItem('postureShoulderCalibrationData', JSON.stringify(calibrationData));
        console.log('Shoulder calibration data saved for background use');
    }
    
    // Load calibration data from localStorage
    loadCalibrationData() {
        try {
            const data = localStorage.getItem('postureShoulderCalibrationData');
            if (data) {
                const parsedData = JSON.parse(data);
                this.calibratedShoulderAngle = parsedData.calibratedShoulderAngle;
                this.calibratedNeckAngle = parsedData.calibratedNeckAngle;
                this.shoulderThreshold = parsedData.shoulderThreshold;
                this.neckThreshold = parsedData.neckThreshold;
                console.log('Loaded shoulder calibration data:', parsedData);
                return true;
            }
        } catch (error) {
            console.error('Error loading shoulder calibration data:', error);
        }
        return false;
    }
    
    // Start background capture and processing
    startBackgroundCapture() {
        if (this.backgroundAnalysisActive) return;
        
        this.backgroundAnalysisActive = true;
        console.log('Starting background capture for shoulder/neck posture');
        
        // Create a frame capture interval at lower frequency to save resources
        this.backgroundInterval = setInterval(() => {
            if (this.videoElement.readyState >= 2) {
                // Create a canvas to capture the current frame
                const canvas = document.createElement('canvas');
                canvas.width = this.videoElement.videoWidth;
                canvas.height = this.videoElement.videoHeight;
                const ctx = canvas.getContext('2d');
                
                // Draw the current video frame to the canvas
                ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
                
                // Convert to image data for processing
                this.lastProcessedFrame = canvas.toDataURL('image/jpeg', 0.5);
                
                // Process the frame
                this.processBackgroundFrame(this.lastProcessedFrame);
            }
        }, 1000); // Check posture every second in background mode
    }
    
    // Stop background capture
    stopBackgroundCapture() {
        if (this.backgroundInterval) {
            clearInterval(this.backgroundInterval);
            this.backgroundInterval = null;
        }
        this.backgroundAnalysisActive = false;
        console.log('Stopped background capture for shoulder/neck posture');
    }
    
    // Process frames when in background mode
    async processBackgroundFrame(frameData) {
        try {
            // Create an image element from the captured frame
            const img = new Image();
            img.src = frameData;
            
            await new Promise(resolve => {
                img.onload = resolve;
            });
            
            // Send to Pose for processing
            await this.pose.send({ image: img });
            
            console.log('Background frame processed for pose detection');
        } catch (error) {
            console.error('Error processing background frame for pose:', error);
        }
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
        
        // If not calibrated yet, check if we can load from storage
        if (this.calibratedShoulderAngle === null && this.loadCalibrationData()) {
            console.log('Loaded shoulder calibration data from storage');
            this.backgroundButton.disabled = false;
        }
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
        
        // Reset posture state
        this.postureDropStartTime = null;
        this.isPoorPosture = false;
        this.shoulderAngleBuffer = [];
        this.neckAngleBuffer = [];

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
                
                // Enable background button after calibration
                this.backgroundButton.disabled = false;
                
                // Send notification to confirm calibration
                this.sendNotification(
                    'Calibration Complete',
                    'Your posture baseline has been recorded. Notifications are now active.',
                    'shoulder'
                );
                
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
            let shoulderThreshold = this.shoulderThreshold * this.sensitivityMultiplier;
            
            // Check neck posture
            let neckStatus = '';
            let neckDeviation = Math.abs(smoothedNeckAngle - this.calibratedNeckAngle);
            let neckThreshold = this.neckThreshold * this.sensitivityMultiplier;
            
            // Determine if posture is poor overall
            const isPoorPostureNow = (shoulderDeviation > shoulderThreshold) || (neckDeviation > neckThreshold);
            
            // Duration-based notification system similar to head detection
            if (isPoorPostureNow) {
                // If this is the start of poor posture, record the time
                if (!this.isPoorPosture) {
                    this.postureDropStartTime = Date.now();
                    this.isPoorPosture = true;
                    console.log("Poor posture detected - starting timer");
                }
                
                // Check shoulder status
                if (shoulderDeviation > shoulderThreshold) {
                    if (smoothedShoulderAngle > this.calibratedShoulderAngle) {
                        shoulderStatus = 'Shoulders are hunched forward';
                        this.shoulderStatus.textContent = shoulderStatus;
                        this.shoulderStatus.style.color = 'red';
                    } else {
                        shoulderStatus = 'Shoulders are too far back';
                        this.shoulderStatus.textContent = shoulderStatus;
                        this.shoulderStatus.style.color = 'orange';
                    }
                } else {
                    shoulderStatus = 'Shoulder posture is good';
                    this.shoulderStatus.textContent = shoulderStatus;
                    this.shoulderStatus.style.color = 'green';
                }
                
                // Check neck status
                if (neckDeviation > neckThreshold) {
                    if (smoothedNeckAngle < this.calibratedNeckAngle) {
                        neckStatus = 'Your head is too far forward';
                        this.neckStatus.textContent = neckStatus;
                        this.neckStatus.style.color = 'red';
                    } else {
                        neckStatus = 'Your head is too far back';
                        this.neckStatus.textContent = neckStatus;
                        this.neckStatus.style.color = 'orange';
                    }
                } else {
                    neckStatus = 'Neck posture is good';
                    this.neckStatus.textContent = neckStatus;
                    this.neckStatus.style.color = 'green';
                }
                
                // Show recommendation box
                this.postureRecommendation.style.display = 'block';
                
                // Check if posture has been poor for longer than the threshold duration
                const poorPostureDuration = Date.now() - this.postureDropStartTime;
                if (poorPostureDuration > this.postureDropDuration) {
                    console.log(`Poor posture for ${poorPostureDuration}ms - sending notification`);
                    
                    // Determine which notification to send based on what's worse
                    if (shoulderDeviation > neckDeviation) {
                        this.sendNotification(
                            'Poor Shoulder Posture',
                            shoulderStatus,
                            'shoulder'
                        );
                    } else {
                        this.sendNotification(
                            'Poor Neck Posture',
                            neckStatus,
                            'neck'
                        );
                    }
                }
            } else {
                // Reset poor posture state if posture is back to normal
                if (this.isPoorPosture) {
                    console.log("Posture returned to normal");
                }
                this.isPoorPosture = false;
                this.postureDropStartTime = null;
                
                // Update UI
                this.shoulderStatus.textContent = 'Shoulder Position: Good';
                this.shoulderStatus.style.color = 'green';
                this.neckStatus.textContent = 'Neck Position: Good';
                this.neckStatus.style.color = 'green';
                
                // Hide recommendation box
                this.postureRecommendation.style.display = 'none';
            }
            
            // Update recommendations if needed
            if (isPoorPostureNow) {
                this.updateRecommendations(shoulderStatus, neckStatus);
            }
            
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
        this.backgroundButton.disabled = true;
    }
    
    // Reset all calibration data
    reset() {
        this.calibratedShoulderAngle = null;
        this.calibratedNeckAngle = null;
        this.shoulderAngleBuffer = [];
        this.neckAngleBuffer = [];
        this.shoulderStatus.textContent = 'Shoulder Position: Waiting for calibration...';
        this.shoulderStatus.style.color = '';
        this.neckStatus.textContent = 'Neck Position: Waiting for calibration...';
        this.neckStatus.style.color = '';
        this.postureRecommendation.style.display = 'none';
        this.postureRecommendation.textContent = '';
        this.calibrationStatus.textContent = '';
        this.calibrationProgress.progress = 0;
        this.backgroundButton.disabled = true;
    }
}

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new PoseDetection();
});