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
        
        // Head position threshold detection settings
        this.headPositionThreshold = 10; // Degrees of deviation from calibrated position
        this.headDropDuration = 2000; // Time in milliseconds to trigger alert (2 seconds)
        this.headDropStartTime = null; // Timestamp when head dropping started

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
        this.notificationCooldown = 10000;     // 10 seconds between notifications
        this.isHeadDropping = false;           // Track if head is currently dropping
        this.notificationsEnabled = false;     // Track if notifications have been enabled
        
        // Background mode variables
        this.isBackgroundMonitoringEnabled = false;
        this.backgroundInterval = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.backgroundAnalysisActive = false;
        this.lastProcessedFrame = null;
        
        // Set up the system
        this.setupEventListeners();
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
        if (type === 'head') {
            // Check cooldown period
            if (now - this.lastHeadNotification < this.notificationCooldown) {
                console.log("Head notification on cooldown");
                return; // Still in cooldown period
            }
            this.lastHeadNotification = now;
        } else if (type === 'mouth') {
            // Check cooldown period
            if (now - this.lastMouthNotification < this.notificationCooldown) {
                console.log("Mouth notification on cooldown");
                return; // Still in cooldown period
            }
            this.lastMouthNotification = now;
        }

        // Create and display the notification
        try {
            const notification = new Notification(title, {
                body: message,
                icon: 'https://icon-library.com/images/posture-icon/posture-icon-29.jpg', // Default icon
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

    // Set up event listeners and FaceMesh configuration
    setupEventListeners() {
        this.startButton.addEventListener('click', async () => {
            // Request notification permission when starting camera
            await this.enableNotifications();
            this.startCamera();
        });
        
        this.calibrateButton.addEventListener('click', () => this.startCalibration());

        // Configure FaceMesh settings
        this.faceMesh.setOptions({
            maxNumFaces: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.faceMesh.onResults(results => this.onResults(results));
        
        // Add background monitoring toggle button
        const backgroundButton = document.createElement('button');
        backgroundButton.id = 'backgroundButton';
        backgroundButton.className = 'mdc-button mdc-button--raised';
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
        
        // Register service worker if supported
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/service-worker.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);
                })
                .catch(error => {
                    console.log('ServiceWorker registration failed: ', error);
                });
        }
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
        if (this.calibratedAngle === null || this.calibratedMouthDistance === null) {
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
            'head'
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
            calibratedAngle: this.calibratedAngle,
            calibratedMouthDistance: this.calibratedMouthDistance,
            headPositionThreshold: this.headPositionThreshold,
            lastUpdated: Date.now()
        };
        
        localStorage.setItem('postureCalibrationData', JSON.stringify(calibrationData));
        console.log('Calibration data saved for background use');
    }
    
    // Load calibration data from localStorage
    loadCalibrationData() {
        try {
            const data = localStorage.getItem('postureCalibrationData');
            if (data) {
                const parsedData = JSON.parse(data);
                this.calibratedAngle = parsedData.calibratedAngle;
                this.calibratedMouthDistance = parsedData.calibratedMouthDistance;
                this.headPositionThreshold = parsedData.headPositionThreshold;
                console.log('Loaded calibration data:', parsedData);
                return true;
            }
        } catch (error) {
            console.error('Error loading calibration data:', error);
        }
        return false;
    }
    
    // Start background capture and processing
    startBackgroundCapture() {
        if (this.backgroundAnalysisActive) return;
        
        this.backgroundAnalysisActive = true;
        console.log('Starting background capture');
        
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
        console.log('Stopped background capture');
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
            
            // Send to FaceMesh for processing
            await this.faceMesh.send({ image: img });
            
            console.log('Background frame processed');
        } catch (error) {
            console.error('Error processing background frame:', error);
        }
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

        // Reset head dropping state
        this.headDropStartTime = null;
        this.isHeadDropping = false;
        this.headAngleBuffer = [];

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
                
                // Enable background button after calibration
                this.backgroundButton.disabled = false;
                
                // Send notification to confirm calibration
                this.sendNotification(
                    'Calibration Complete',
                    'Your posture baseline has been recorded. Notifications are now active.',
                    'head'
                );
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

    // Process detection results and trigger notifications
    onResults(results) {
        this.lastResults = results;

        if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
            return; // No face detected
        }
        
        // If not calibrated yet, check if we can load from storage
        if (this.calibratedAngle === null && this.loadCalibrationData()) {
            console.log('Loaded calibration data from storage');
            this.backgroundButton.disabled = false;
        }
        
        // Still not calibrated, can't proceed
        if (this.calibratedAngle === null) {
            return;
        }

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

        // Add to buffer for smoothing head angle
        this.headAngleBuffer.push(angle);
        if (this.headAngleBuffer.length > this.bufferSize) {
            this.headAngleBuffer.shift();
        }
        
        // Get smoothed angle
        const smoothedAngle = this.headAngleBuffer.reduce((a, b) => a + b) / this.headAngleBuffer.length;
        
        // Debug output
        console.log(`Current angle: ${smoothedAngle.toFixed(1)}, Calibrated: ${this.calibratedAngle.toFixed(1)}, Difference: ${(this.calibratedAngle - smoothedAngle).toFixed(1)}`);
        
        // Head position detection and notification with duration threshold
        const headDifference = this.calibratedAngle - smoothedAngle;
        const isHeadCurrentlyDropping = headDifference > this.headPositionThreshold;
        
        // Check if head is dropping past the threshold
        if (isHeadCurrentlyDropping) {
            // If this is the start of head dropping, record the time
            if (!this.isHeadDropping) {
                this.headDropStartTime = Date.now();
                this.isHeadDropping = true;
                console.log("Head dropping detected - starting timer");
            }
            
            // Update UI if visible
            if (document.visibilityState === 'visible' && this.headStatus) {
                this.headStatus.textContent = `Head Position: Dropping! (${headDifference.toFixed(1)}° below ideal)`;
                this.headStatus.style.color = 'red';
            }
            
            // Check if head has been dropping for longer than the threshold duration
            const droppingDuration = Date.now() - this.headDropStartTime;
            if (droppingDuration > this.headDropDuration) {
                console.log(`Head has been dropping for ${droppingDuration}ms - sending notification`);
                this.sendNotification(
                    'Poor Posture Detected',
                    'Your head has been dropping for too long. Please correct your posture.',
                    'head'
                );
            }
        } else {
            // Reset head dropping state if head is back to normal position
            if (this.isHeadDropping) {
                console.log("Head position returned to normal");
            }
            this.isHeadDropping = false;
            this.headDropStartTime = null;
            
            // Update UI if visible
            if (document.visibilityState === 'visible' && this.headStatus) {
                this.headStatus.textContent = 'Head Position: Good';
                this.headStatus.style.color = 'green';
            }
        }

        // Mouth position detection and notification
        if (mouthDistance > this.calibratedMouthDistance * 1.5) {
            if (!this.mouthOpenStartTime) {
                this.mouthOpenStartTime = Date.now();
            } else if (Date.now() - this.mouthOpenStartTime > 5000) {
                // Update UI if visible
                if (document.visibilityState === 'visible' && this.mouthStatus) {
                    this.mouthStatus.textContent = 'Mouth: Open for too long!';
                    this.mouthStatus.style.color = 'red';
                }

                this.sendNotification(
                    'Mouth Open Alert',
                    'Your mouth has been open for too long.',
                    'mouth'
                );
            }
        } else {
            this.mouthOpenStartTime = null;
            
            // Update UI if visible
            if (document.visibilityState === 'visible' && this.mouthStatus) {
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