import { getAssetUrl } from './assetHelper.js';

// EXTENSION PORT (Phase 1): transformers.js is lazy-loaded via the offscreen
// import map, so the deterministic regex engine (<2ms, zero downloads) works even
// when the ~103MB BERT weights or the transformers runtime are unavailable.
// Original web-demo header: `import { pipeline, env } from '@huggingface/transformers'`.
let _transformers = null;
let _transformersFailed = false;
async function getTransformers() {
  if (_transformers) return _transformers;
  if (_transformersFailed) throw new Error('transformers.js unavailable (prior load failed)');
  try {
    _transformers = await import('@huggingface/transformers');
    _transformers.env.allowLocalModels = true;
    _transformers.env.allowRemoteModels = true;
    _transformers.env.useBrowserCache = typeof window !== 'undefined';
    return _transformers;
  } catch (e) {
    _transformersFailed = true;
    throw e;
  }
}
export function isNERAvailable() { return !_transformersFailed; }

// Lines that only contain structured key-value fields already 100% matched by deterministic regex
const SKIP_PATTERNS = /^\s*(?:\*|-|\d+\.)?\s*(?:Date of Birth|Mobile|Landline|Alternate\s*(?:Mobile|Phone|Landline|Number|No\.?)|Aadhaar|Masked|PAN|Voter|Driving|Vehicle|GSTIN|Bank IFSC|Bank Account|Account Number|Routing Transit|SWIFT|UPI|SSN|Belgian|Amex|Eurozone|Credit Card|Card Verification|Corporate Mobile|Policy Group|Individual Member|Employee Identification|Freight Forwarder|Airline Ticket|Digital Fingerprint|Secure PGP|Corporate IP|Direct Line|Gender Identity|Marital Status|Age|Blood Type|Expiration Date|TAN|CIN|ITIN|NINO|ABHA|UAN|Order ID|Order No|Tracking ID|Consignment|Record ID|All Bookmarks|New Tab|Send Anywhere|GeForce NOW|Google Search|Total Invoice Amount|Grand Total|Total Amount|Net Taxable|Central GST|State GST|CGST|SGST|IGST|Base Price|Discount Applied|Subtotal|HSN Code|Package Dimensions|Package Weight|Quantity|Unit Price|Payment Mode)\b/i;

let cachedNERPipeline = null;
export const activeNEREngineName = 'Local Fine-Tuned MiniLM-L6 (Offline WASM) + Regex';

export async function getNERPipeline(onProgress = null) {
  if (!cachedNERPipeline) {
    let tx;
    try {
      tx = await getTransformers();
    } catch (e) {
      console.warn('[PIIDetector] transformers.js unavailable — regex-only mode:', e?.message ?? e);
      return { ner: null, engine: 'Regex-only (BERT unavailable)', nerUnavailable: true };
    }
    const localModelPath = typeof window === 'undefined' ? './public/models/vista_pii' : getAssetUrl('models/vista_pii');
    let loaded = false;

    // 1. Pre-flight check: verify local quantized ONNX binary exists and is not a 404 HTML page or LFS pointer
    let isLocalValid = false;
    if (typeof window !== 'undefined' && window.fetch) {
      try {
        const testUrl = getAssetUrl('models/vista_pii/model_quantized.onnx');
        const testRes = await fetch(testUrl, { method: 'HEAD' });
        if (testRes.ok) {
          const cl = parseInt(testRes.headers.get('content-length') || '0', 10);
          if (cl > 1024 * 1024) {
            isLocalValid = true;
          } else if (cl === 0) {
            // If Content-Length header is omitted by web server, sample the initial bytes
            const rangeRes = await fetch(testUrl, { headers: { Range: 'bytes=0-200' } });
            if (rangeRes.ok) {
              const buf = await rangeRes.arrayBuffer();
              const sample = new TextDecoder().decode(buf);
              if (!sample.startsWith('version https://git-lfs') && !sample.includes('<!DOCTYPE') && !sample.includes('<html')) {
                isLocalValid = true;
              }
            }
          }
        }
      } catch (e) {
        console.warn('[PIIDetector] Local model pre-flight check notice:', e);
      }
    } else {
      isLocalValid = true;
    }

    // 2. Load from local public assets if validated
    if (isLocalValid) {
      try {
        console.log('[PIIDetector] Loading quantized BERT-NER model from local assets...');
        cachedNERPipeline = await tx.pipeline('token-classification', localModelPath, {
          dtype: 'q8',
          subfolder: '',
          progress_callback: onProgress || undefined
        });
        loaded = true;
      } catch (localErr) {
        console.warn('[PIIDetector] Local quantized model load failed, falling back to Hugging Face CDN:', localErr);
      }
    }

    // 3. Graceful fallback: load directly from Hugging Face Hub (Xenova/bert-base-NER) with dtype 'q8'
    if (!loaded) {
      console.log('[PIIDetector] Loading official Xenova/bert-base-NER from Hugging Face CDN (cached in browser)...');
      cachedNERPipeline = await tx.pipeline('token-classification', 'Xenova/bert-base-NER', {
        dtype: 'q8',
        progress_callback: onProgress || undefined
      });
    }
  }
  return { ner: cachedNERPipeline, engine: activeNEREngineName };
}

export function resetNERPipeline() {
  cachedNERPipeline = null;
}

// Comprehensive UI, E-Commerce, Navigation, Browser Chrome and App Stopwords (Never PII)
export const UI_STOPWORDS = new Set([
  'home', 'account', 'my account', 'order', 'orders', 'my orders', 'my', 'invoice',
  'download', 'download invoice', 'return', 'exchange', 'cart', 'more', 'seller',
  'become a seller', 'item', 'items', 'search', 'search for products', 'products',
  'brands', 'view', 'details', 'price', 'price details', 'total', 'total amount',
  'discount', 'other discount', 'delivery', 'delivery details', 'delivered', 'confirmed',
  'order confirmed', 'updates', 'see all updates', 'policy', 'return policy', 'valid',
  'know', 'know more', 'chat', 'chat with us', 'offers', 'offers earned', 'gift',
  'rate', 'experience', 'rate your experience', 'reward', 'extra', 'extra cost', 'free',
  'special', 'special price', 'listing', 'listing price', 'amount', 'fees', 'total fees',
  'netf', 'lix', 'netflix', 'flipkart', 'fliptart', 'flipt', 'cultx', 'shoes', 'men', 'women', 'kids',
  'baby & kids', 'electronics', 'appliances', 'tvs & appliances', 'home & furniture',
  'furniture', 'sports', 'sports, books & more', 'flights', 'offer zone', 'zone',
  'save', 'cancel', 'submit', 'select', 'try', 'sample', 'icon', 'logo', 'button',
  'close', 'open', 'menu', 'nav', 'header', 'footer', 'next', 'prev', 'back', 'help',
  'login', 'logout', 'sign in', 'sign out', 'settings', 'profile',
  // Browser Tabs, Bookmarks, Navigation & E-Commerce App Categories
  'online', 'shopping', 'online shopping', 'store', 'site', 'travel', 'fashion', 'mobiles',
  'beauty', 'toys', 'food', 'auto', 'books', 'wheeler', 'korean', 'shirts', 'jeans',
  'sneakers', 'watches', 'backpacks', 'tees', 'athleisure', 'formals', 'festivals',
  'india', 'kurta', 'dresses', 'casual', 'luggage', 'jewellery', 'sarees', 'trousers',
  'kurtis', 'drips', 'loved ones', 'loved', 'ones', 'shop', 'shop for',
  'maps', 'google maps', 'gmail', 'youtube', 'whatsapp', 'tab', 'new tab', 'bookmarks',
  'all bookmarks', 'dashboard', 'clerk', 'gemini', 'ask gemini', 'chrome', 'browser',
  'geforce', 'geforce now', 'send anywhere', 'vista', 'modeltesting', 'github', 'github.com',
  'youknow', 'gen z', 'gen', 'namaste', 'bleach', 'season', 'untitled', 'watc', 'watch', 'fil',
  'metformin', 'atorvastatin', 'telmisartan', 'paracetamol', 'creatinine', 'glucose', 'cholesterol',
  'triglycerides', 'prandial', 'dyspnea', 'palpitations', 'hemoglobin', 'electrolytes', 'echocardiography',
  'ayushman', 'bharat', 'complaints', 'vitals', 'investigation', 'findings', 'medication',
  'bluedart', 'omnitech', 'razorpay', 'waybill', 'delhivery', 'shipment', 'consignment', 'courier',
  'upi', 'vpa', 'imps', 'neft', 'rtgs', 'cif', 'micr', 'nominee', 'sku', 'hsn',
  'livechat', 'intercom', 'zendesk', 'slack', 'salesforce', 'gateway',
  // Academic, University, Examination, and Institutional Document Terms (Never PII)
  'mait', 'ggsipu', 'ipu', 'dtu', 'nsut', 'iit', 'nit', 'bits', 'iiit', 'du', 'jnu',
  'btech', 'mtech', 'bca', 'mca', 'bsc', 'msc', 'bba', 'mba', 'phd', 'cse', 'ece', 'it', 'mech',
  'coe', 'exam', 'examination', 'admit', 'card', 'roll', 'institution', 'programme',
  'batch', 'code', 'papers', 'appearing', 'commencement', 'entry', 'start', 'gate', 'closing',
  'dean', 'director', 'principal', 'controller', 'signature', 'candidate', 'minutes',
  // Government, Transport, Driving License, and Identity Card System Terms
  'transport', 'department', 'government', 'nct', 'licence', 'license', 'union',
  'validity', 'blood', 'group', 'donor', 'organ', 'issue', 'issued',
  // Calendar Months, Abbreviations, and Days (Never PII person names)
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
  'mon', 'monday', 'tue', 'tuesday', 'wed', 'wednesday', 'thu', 'thursday',
  'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
  // School and Examination Subjects (Never PII person names)
  'hindi', 'sanskrit', 'mathematics', 'maths', 'science', 'social', 'english',
  'physics', 'chemistry', 'biology', 'mil', 'sil', 'aggregate', 'division',
  'theory', 'practical', 'assessment', 'marks', 'obtained', 'first', 'pass', 'fail',
  // Bank Passbook and Institutional Stopwords
  'kendra', 'branch', 'link', 'kiosk', 'gramin', 'sponsoring', 'sponsored',
  'holder', 'account', 'passbook', 'statement', 'signature', 'seal'
]);

// Company, Organization, Corporate & Brand detection filter (never PII)
export const COMPANY_INDICATORS = /\b(?:Inc|Corp|Corporation|Ltd|Limited|LLC|LLP|Pvt|Private|GmbH|AG|SA|BV|NV|Bank|Banque|Labs|Laboratories|Technologies|Technology|Tech|Enterprises|Solutions|Services|Ventures|Holdings|Group|Co|Company|International|Global|Center|Hospital|Clinic|Pharma|Biopharma|University|College|Institute|Campus|School|Academy|Board|Faculty|Store|Seller|Shop|Retail|Studio|Agency|Brand|Jeans|Denim|Clothing|Fashion|Apparel|Wear|Outfitters|Garments|Pepe|Zara|Nike|Adidas|Puma|Levis?|Flipkart|Fliptart|Flipt|Amazon|Myntra|Meesho|Snapdeal|JioMart|Swiggy|Zomato|Uber|Ola|Paytm|PhonePe|Google|Gmail|YouTube|WhatsApp|Nvidia|GeForce|GitHub|Git|VISTA|Chrome|Android|iOS|Apple|Microsoft|Windows|Clerk|Gemini|Send Anywhere|Netflix|CultX|Search|Explore|BlueDart|OmniTech|Razorpay|Waybill|Delhivery|FedEx|DHL|DTDC|Shadowfax|Xpressbees|Shiprocket|Ekart|LiveChat|Intercom|Zendesk|Slack|Salesforce|MAIT|GGSIPU|DTU|NSUT|IIT|NIT|IIIT|BITS|IGNOU|CBSE|UGC|AICTE)\b/i;

// Number words & monetary currency vocabulary to reject amount-in-words false positives
export const NUMBER_WORDS = new Set([
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty',
  'thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred','thousand','lakh','crore',
  'million','billion','trillion','and','only','inr','usd','eur','gbp','rs','rupees','rupee','cents','dollars','dollar'
]);

// Comprehensive Indian and Global major cities (to prevent NER from classifying city names as person names)
export const KNOWN_CITIES_SET = new Set([
  'kolkata', 'calcutta', 'mumbai', 'bombay', 'delhi', 'new delhi', 'bengaluru', 'bangalore',
  'chennai', 'madras', 'hyderabad', 'ahmedabad', 'pune', 'surat', 'jaipur', 'lucknow',
  'kanpur', 'nagpur', 'indore', 'thane', 'bhopal', 'visakhapatnam', 'patna', 'vadodara',
  'ghaziabad', 'ludhiana', 'agra', 'nashik', 'faridabad', 'meerut', 'rajkot', 'varanasi',
  'srinagar', 'aurangabad', 'dhanbad', 'amritsar', 'navi mumbai', 'allahabad', 'prayagraj',
  'ranchi', 'howrah', 'coimbatore', 'jabalpur', 'gwalior', 'vijayawada', 'jodhpur', 'madurai',
  'raipur', 'kota', 'guwahati', 'chandigarh', 'solapur', 'bareilly', 'moradabad', 'mysore',
  'gurgaon', 'gurugram', 'aligarh', 'jalandhar', 'bhubaneswar', 'salem', 'warangal',
  'thiruvananthapuram', 'gorakhpur', 'bikaner', 'amravati', 'noida', 'jamshedpur', 'bhilai',
  'cuttack', 'kochi', 'nellore', 'bhavnagar', 'dehradun', 'durgapur', 'asansol', 'rourkela',
  'ajmer', 'jamnagar', 'ujjain', 'siliguri', 'jhansi', 'jammu', 'mangalore', 'udaipur',
  'mathura', 'patiala', 'rohtak', 'shimla', 'panaji', 'new york', 'london', 'paris',
  'tokyo', 'singapore', 'sydney', 'toronto', 'dubai', 'abu dhabi', 'doha', 'riyadh'
]);

// Valid ISO 3166-1 alpha-2 country codes used in real international IBANs
const IBAN_COUNTRIES = 'AL|AD|AT|AZ|BH|BE|BA|BR|BG|CR|HR|CY|CZ|DK|DO|EE|FO|FI|FR|GE|DE|GI|GR|GL|GT|HU|IS|IE|IL|IT|JO|KZ|XK|KW|LV|LB|LI|LT|LU|MK|MT|MR|MU|MD|MC|ME|NL|NO|PK|PS|PL|PT|QA|RO|SM|SA|RS|SK|SI|ES|SE|CH|TN|TR|AE|GB|VA';

// --- 1. COMPREHENSIVE REGEX SUITE (INDIAN + GLOBAL) ---
export const REGEX_RULES = [
  // 1. Email Addresses (standard format; also tolerates OCR stray "(" before "@" and spaces around the domain dot, e.g. "name(@gmail.com", "name@ gmail . com")
  { pattern: /\b[A-Za-z0-9._%+-]+\s*\(?\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/gi, tag: 'EMAIL' },

  // 2. UPI IDs / VPA (non-capturing group so full VPA name@handle is always redacted)
  { pattern: /\b[a-zA-Z0-9.\-_]{2,64}@(?:okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|upi|axl|apl|barodampay|postbank|kotak|icici|sbi|hdfcbank)\b/gi, tag: 'UPI_ID' },

  // 3. Social Media & Platform Handles (@username, @rohitsinghal)
  { pattern: /(?<=\s|^|[([:;,])@\s*[a-zA-Z0-9_.-]{2,32}\b/gi, tag: 'HANDLE' },

  // 4. Labeled Social Handles (Handle: @user, Username: abc_12)
  { pattern: /(?:Handle|Username)\s*[:#]\s*#?\s*([a-zA-Z0-9_.-]{3,32})\b/gi, tag: 'HANDLE' },

  // 4b. Employee, Customer, CIF, Ticket, Incident, Record, Badge, Candidate & Token IDs (ID: EMP-2024-88391, Ticket #TKT-889104)
  { pattern: /\b(?:Ticket(?:\s*(?:ID|Id|No\.?|Number|#|Ref\.?))?|Customer\s*(?:ID|Id|No\.?|Number|#)|CIF(?:\s*(?:ID|Id|No\.?|Number|#))?|Client\s*(?:ID|Id|No\.?|Number|#)|Record\s*ID|Employee\s*(?:ID|Code|No\.?)|Badge\s*ID|Staff\s*ID|Candidate\s*ID|Member\s*ID)\s*[:#]\s*#?([A-Za-z0-9_-]{3,32})\b/gi, tag: 'ID' },
  { pattern: /\b(?:EMP|BADGE|REC|CAND|CIF|TKT|INC|TICKET)[-_]\d{4,}[-_]?[A-Za-z0-9]*\b/gi, tag: 'ID' },

  // 4c. Academic, Student, University & Examination IDs (Roll No: 12914802724, Enrollment No: 02714802724, Roll Code: 51059)
  { pattern: /\b(?:Roll\s*(?:No\.?|Number|Code|#)?|Enrollment\s*(?:No\.?|Number|#)?|Registration\s*(?:No\.?|Number|#)?|Reg\s*(?:No\.?|Number|#)|Student\s*(?:ID|Id|No\.?|Number|#)|Candidate\s*(?:ID|Id|Code|No\.?|Number|#)|Hall\s*Ticket\s*(?:No\.?|Number|#)?|PRN(?:\s*(?:No\.?|Number|#))?)\s*[:#-]?[\s.…_-]*#?((?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,24})\b/gi, tag: 'ID' },

  // 5. URLs & Personal Websites
  { pattern: /\b(?:https?:\/\/|www\.)[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:\/[a-zA-Z0-9()@:%_+.~#?&//=]*)?/gi, tag: 'URL' },

  // 6. Credit & Debit Cards (Evaluated before Aadhaar; covers standard 16-digit cards, Amex 15-digit, Diners, JCB, UnionPay, and PCI masked cards like 6071-XXXX-XXXX-8921)
  { pattern: /\b(?:4\d{3}|5[0-8]\d{2}|6[0-5]\d{2}|2[2-7]\d{2}|8[12]\d{2}|3[47]\d{2}|3(?:0[0-5]|[68]\d)\d|35\d{2}|62\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b|\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g, tag: 'CARD' },
  { pattern: /\b\d{4}[-\s]?[X*x]{4}[-\s]?[X*x]{4}[-\s]?\d{4}\b|\b\d{6}[-\s]?[X*x]{6}[-\s]?\d{4}\b/g, tag: 'CARD' },

  // 7. Card Verification Value (CVV/CVC)
  { pattern: /\b(?:CVV|CVC|CVV2|CVC2|Security Code|Card Verification Value(?:\s*\(CVV\))?)\s*(?:[:#=]|of|is)?\s*([0-9]{3,4})\b/gi, tag: 'CVV' },

  // 8. Card Expiration Date
  { pattern: /\b(?:Exp(?:ir(?:y|ation))?(?:\s*Date)?|valid thru|expires?)\s*(?:[:#=]|of|is|on)?\s*((?:0[1-9]|1[0-2])[\/-](?:20\d{2}|\d{2}))\b/gi, tag: 'CARD_EXPIRY' },

  // 9. E-Commerce Order IDs, Consignments & Tracking Numbers (Flipkart OD, Amazon, etc.)
  { pattern: /\b(?:Order|Consignment|Tracking|Waybill|AWB|Shipment|Dispatch)\s*(?:ID|Id|No\.?|Number|#|Ref\.?|Reference)?\s*[:#-]?\s*#?((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,32})\b/gi, tag: 'ORDER_ID' },
  { pattern: /\bOrder\s*[:#-]\s*#?((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,32})\b/gi, tag: 'ORDER_ID' },
  { pattern: /\b(?:My Orders|Orders?)\s*[>»/|:-]\s*#?((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,32})\b/gi, tag: 'ORDER_ID' },
  { pattern: /\b[oO][dD]\d{16,20}\b/g, tag: 'ORDER_ID' },
  { pattern: /\b\d{3}-\d{7}-\d{7}\b/g, tag: 'ORDER_ID' },
  { pattern: /\b(?:Txn|Transaction|Payment|Auth(?:\s*Code)?|UTR|IMPS(?:\s*Ref)?|NEFT(?:\s*Ref)?|RTGS(?:\s*Ref)?|Bank\s*Ref(?:erence)?)\s*(?:ID|Id|No\.?|Number|#|Ref\.?|Reference)?\s*[:#-]?\s*#?((?=[A-Za-z0-9/-]*\d)[A-Za-z0-9/-]{6,36})\b/gi, tag: 'ID' },
  { pattern: /\b(?:Invoice\s*(?:Ref\.?|Reference|No\.?|Number|#))\s*[:#-]\s*#?((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,32})\b/gi, tag: 'ID' },
  { pattern: /\b(?:UPI\s*[/:-]\s*(\d{10,16})|UPI\s*(?:Ref|Reference|Txn|Transaction)\s*[:#-]?\s*#?([A-Za-z0-9/-]{6,36}))\b/gi, tag: 'ID' },

  // 10. IBAN (Requires real ISO country code)
  { pattern: new RegExp(String.raw`\b(?:${IBAN_COUNTRIES})\d{2}(?:[\s-]?\d{4}){3,7}\b`, 'gi'), tag: 'IBAN' },

  // 11. Indian Aadhaar Card (12 digits, spaced, continuous, or with leader dots)
  { pattern: /\b(?:Aadhaar|Aadhar|UIDAI|UID)(?:\s*(?:No\.?|Number|#))?[:#-]?[\s.…_-]*([2-9]\d{3}[\s.-]?\d{4}[\s.-]?\d{4})\b/gi, tag: 'AADHAAR' },
  { pattern: /(?<!\d[-\s]?)\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b(?![ -]?\d)/g, tag: 'AADHAAR' },
  { pattern: /(?<!\d)\b[2-9]\d{3}\d{4}\d{4}\b(?!\d)/g, tag: 'AADHAAR' },
  { pattern: /(?<![X\d][-\s]?)\b[X]{4}[ -][X]{4}[ -]\d{4}\b(?![ -]?\d)/g, tag: 'AADHAAR' },

  // 12. Indian PAN Card
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, tag: 'PAN' },

  // 13. Indian TAN (Tax Deduction Account Number)
  { pattern: /\b[A-Z]{4}\d{5}[A-Z]\b/g, tag: 'TAN' },

  // 14. Indian GSTIN
  { pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, tag: 'GSTIN' },

  // 15. Indian Bank IFSC Code (Supports standard and OCR 'o' / 'O' variations; requires digits in branch to avoid English words like 'Comfortable')
  { pattern: /\b[A-Za-z]{4}[0oO](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6}\b/gi, tag: 'IFSC' },

  // 15. Indian Voter ID
  { pattern: /\b[A-Z]{3}\d{7}\b/g, tag: 'VOTER_ID' },

  // 16. Indian Driving License (supports DL1 20260048245, DL-0120260048245, DL-14-2026-..., etc.)
  { pattern: /\b[A-Z]{2}[- ]?\d{1,3}[- ]?(?:19|20)\d{2}[- ]?\d{7}\b/gi, tag: 'DRIVING_LICENSE' },
  { pattern: /\b(?:DL|Driving\s*Licen[sc]e(?:\s*No\.?)?)\s*[:#-]?\s*([A-Za-z0-9\s/-]{8,24})\b/gi, tag: 'DRIVING_LICENSE' },

  // 17. Student & Medical Reference Tokens (Excludes generic corporate tokens)
  { pattern: /\b(?:AUS-STU-[\w-]+|MRN-[\w-]+|TX-MED-[\w-]+)\b/g, tag: 'ID' },

  // 18. Vehicle Registration (RC & Bharat Series BH)
  { pattern: /\b[A-Z]{2}[- ]?\d{1,2}[- ]?(?:[A-Z]{1,3}[- ]?)?\d{4}\b|\b\d{2}\s?BH\s?\d{4}\s?[A-Z]{1,2}\b/g, tag: 'VEHICLE_RC' },

  // 19. US Social Security Number (SSN) & ITIN
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, tag: 'SSN' },
  { pattern: /\b9\d{2}-\d{2}-\d{4}\b/g, tag: 'ITIN' },

  // 20. UK National Insurance Number (NINO)
  { pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/gi, tag: 'UK_NINO' },

  // 21. Belgian National ID / BIS
  { pattern: /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b/g, tag: 'NATIONAL_ID' },

  // 19. Ayushman Bharat Health Account (ABHA 14-digit ID)
  { pattern: /\b(?:ABHA(?:\s*(?:ID|Number|No\.?))?\s*[:#-]?\s*)?(\d{2}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4})\b/gi, tag: 'ABHA' },

  // 19b. Health & General Insurance Policy Numbers (e.g. TPA-MED-8892104)
  { pattern: /\b(?:Policy\s*(?:No\.?|Number|#)|Insurance\s*(?:Policy|No\.?|#)?|TPA(?:\s*(?:ID|No\.?|#))?)\s*[:#-]?\s*([A-Za-z0-9/-]{6,24})\b/gi, tag: 'POLICY_NUMBER' },

  // 20. Passports (Indian 8-char, US/Global alphanumeric)
  { pattern: /\b[A-PR-WYa-pr-wy][1-9]\d{6}\b|\b[A-Z]\d{7,8}[A-Z]?\b/g, tag: 'PASSPORT' },

  // 20. Phone Numbers: Indian Mobile (all formats: +91 98765 43210, 98765 43210, 9876543210, (+91 98765 43210), 0-prefixed)
  { pattern: /(?:\(\+91[\s.\u2010-\u2015-]?[6-9]\d{4}[\s.\u2010-\u2015-]?\d{5}\)|\+91[\s.\u2010-\u2015-]?[6-9]\d{4}[\s.\u2010-\u2015-]?\d{5}\b|\b(?:\+91[\s.\u2010-\u2015-]?)?[6-9]\d{4}[\s.\u2010-\u2015-]?\d{5}\b|\b(?:\+91[\s.\u2010-\u2015-]?)?[6-9]\d{2}[\s.\u2010-\u2015-]?\d{3}[\s.\u2010-\u2015-]?\d{4}\b|\b0[6-9]\d{4}[\s.\u2010-\u2015-]?\d{5}\b|\b0[6-9]\d{9}\b|\b[6-9]\d{9}\b)/g, tag: 'PHONE' },
  // 21. Phone Numbers: Indian Landlines (strict STD codes, rejects course codes like 027103(BS103))
  { pattern: /(?<![/(A-Za-z0-9])\b0(?:11|20|22|33|40|44|79|80)[-\s]?\d{4}[-\s]?\d{4}\b(?![/)A-Za-z0-9])|(?<![/(A-Za-z0-9])\b0(?:120|124|129|141|161|172|175|181|261|265|471|484|512|522|755)[-\s]?\d{6,7}\b(?![/)A-Za-z0-9])/g, tag: 'PHONE' },
  // 22. Phone Numbers: US, North American & International (supports +1-555-019–2834 with en-dash/em-dash, 555-014-9981, (555) 014-9981)
  { pattern: /(?:\+?1[\s.\u2010-\u2015-]?)?(?:\(\d{3}\)|\b\d{3})[\s.\u2010-\u2015-]\d{3}[\s.\u2010-\u2015-]\d{4}\b/g, tag: 'PHONE' },
  { pattern: /\+\d{1,3}[\s.\u2010-\u2015-]\d{1,4}(?:[\s.\u2010-\u2015-]\d{2,4}){2,4}\b|\+\d{1,3}[\s.\u2010-\u2015-]\(?\d{2,4}\)?[\s.\u2010-\u2015-]?\d{3,4}[\s.\u2010-\u2015-]?\d{3,4}\b/g, tag: 'PHONE' },

  // 23. Cryptographic Hashes
  { pattern: /\b[a-f0-9]{64}\b|\b[a-f0-9]{32}\b/gi, tag: 'HASH' },

  // 24. PGP Fingerprints
  { pattern: /(?:\b[0-9A-F]{4}\s*){8,10}\b/g, tag: 'KEY' },

  // 25. IP Addresses (IPv4) - Bounded octets, does not fire on Aadhaar/Phone/Account numbers
  { pattern: /(?<!(?:Aadhaar|Aadhar|UID|Account|A\/c|Mobile|Phone|DL|Voter)[^.\n]{0,30})(?<!\d)\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])){3}\b(?!\d)/gi, tag: 'IP_ADDRESS' },

  // 26. MAC Addresses
  { pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, tag: 'MAC_ADDRESS' },

  // 27. Bank Account Numbers (handles standard, spaced, and dotted leader lines)
  { pattern: /\b(?:Account\s*(?:Number|No\.?|#)?|A\/c\s*(?:No\.?|#)?|Bank\s*A\/c|Acc\s*No\.?)[:#-]?[\s.…_-]*([0-9]{9,18})\b/gi, tag: 'ACCOUNT_NUMBER' },

  // 28. Indian Relations (S/o, D/o, W/o, Son of) -> Person Name
  { pattern: /\b(?:S\/o|D\/o|W\/o|C\/o|Son of|Daughter of|Wife of|Care of)\s*[:-]?\s*[A-Za-z][a-zA-Z.\s]{2,40}\b/gi, tag: 'NAME' },
  { pattern: /\b(?:Near|Opposite|Behind|Beside|Next to|Adjacent to)\s*[:-]?\s*(?!is\b|are\b|was\b|were\b|the\b|a\b|an\b|our\b|we\b|this\b|that\b|these\b|those\b|it\b|all\b)[A-Z][a-zA-Z0-9.,\s-]{2,40}\b/g, tag: 'ADDRESS' },
  { pattern: /\b(?:Vill(?:age)?\b|P\.O\.\b|Post\s*Office\b|Dist(?:rict)?\b|Taluk[a]?\b|Teh(?:sil)?\b|Mandal\b)\s*[:-]?\s*[A-Za-z][a-zA-Z.\s]{2,40}\b/gi, tag: 'ADDRESS' },

  // 29. Informal Indian Housing Prefixes (Room, Chawl, Gali) - requires word boundary and digits or explicit No/#
  { pattern: /\b(?:Room|Chawl|Gali|House|Shop)\b\s*(?:(?:No\.?|#|Number)\s*[:-]?\s*[A-Z0-9/-]+|\d+[A-Za-z]?(?:[-/]\d+)?)\b/gi, tag: 'ADDRESS' },
];

// --- 2. CONTEXTUAL ADDRESS & BIRTHPLACE HEADERS ---
const ADDRESS_HEADER_REGEX = /(?:\bAddress|\bCurrent Residential Address|\bPrimary Residential Address|\bPermanent Residential Address|\bResidential Address|Assigned Workspace|Temporary Lodging|Prior Residential Address|Billing Address|Shipping Address|Mailing Address|Registered Office|Site Location|Delivery Address|Correspondence Address|Permanent Address|Home Address|Local Address)(?:\s*\([^)]*\))?:\s*\n?([^\n*#]+)/gi;
const BIRTH_HEADER_REGEX = /(?:Place of Birth|Date of Birth|DOB):\s*([^\n*#]+)/gi;
const CAPS_NAME_HEADER_REGEX = /(?:Cardholder Name|Full Name|Name|Applicant Name|Patient Name|Student Name|Authorized Signatory|Father's Name|Spouse Name|Son[\s/]*Daughter[\s/]*Wife\s*of|Son of|Daughter of|Wife of|Primary Account Holder|Joint Account Holder|Account Holder(?:\s*Name)?|Beneficiary Name|Nominee(?:\s*Registered)?|Nominee Name|Reporting Manager|HR Business Partner|HR Partner|HR Manager|Contact Person|Spouse|Husband|Wife):\s*([A-Z]{2,}(?:[ \t]+[A-Z]{2,})+)/gi;
const FULL_NAME_HEADER_REGEX = /(?:Patient Legal Name|Patient Name|Full Legal Name|Legal Name|Cardholder Name|Full Name|Applicant Name|Student Name|Authorized Signatory|Father's Name|Spouse Name|Son[\s/]*Daughter[\s/]*Wife\s*of|Son of|Daughter of|Wife of|Attending Senior Consultant|Attending Physician|Doctor Name|Primary Account Holder|Joint Account Holder|Account Holder(?:\s*Name)?|Beneficiary Name|Nominee(?:\s*Registered)?|Nominee Name|Reporting Manager|HR Business Partner|HR Partner|HR Manager|Contact Person|Spouse|Husband|Wife)\s*:\s*([A-Za-z.'’\-]+(?:[ \t]+[A-Za-z.'’\-]+)+(?:,\s*(?:Jr\.?|Sr\.?|II|III|IV|MD|PhD|Esq\.?|RN|MBBS|MS|FACS))?)/gi;
const CONVERSATIONAL_NAME_REGEX = /(?:\b[mM]y name is|\b[rR]egistered (?:simply )?as|\b[iI]nvestigating [oO]fficer:\s*|\b[cC]omplainant:\s*)\s*([A-Z][a-zA-Z'’]+(?:[- ][A-Z][a-zA-Z'’]+){1,3})/g;

// --- 3. UPGRADED COMPREHENSIVE ADDRESS VOCABULARIES ---
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STREET_TYPES = [
  'Street','St','Avenue','Ave','Boulevard','Blvd','Road','Rd','Drive','Lane','Ln','Way','Court','Ct',
  'Circle','Cir','Terrace','Ter','Parkway','Pkwy','Place','Pl','Square','Sq','Plaza','Loop','Row','Run',
  'Trail','Trl','Crossing','Xing','Crescent','Cres','Expressway','Expy','Junction','Jct','Point','Pt',
  'Ridge','Rdg','Valley','Vly','View','Vw','Vista','Walk','Broadway','Esplanade','Landing','Grove',
  'Heights','Hts','Hill','Hollow','Holw','Island','Isle','Meadow','Mews','Orchard','Park','Ranch','River',
  'Shore','Spring','Springs','Alley','Aly','Highway','Hwy','Freeway','Fwy','Causeway','Cswy','Bypass',
  'Byp','Extension','Ext','Path','Wharf','Quay',
  // India / South Asia
  'Marg','Salai','Bazaar','Bazar','Nagar','Colony','Sector','Phase','Enclave','Layout','Society','Vihar',
  'Peth','Chowk','Gali','Galli','Veedhi','Rasta',
];
const ST = STREET_TYPES.map(esc).join('|') + '|Dr';

const DIR       = 'N|S|E|W|NE|NW|SE|SW|North|South|East|West';
const UNITS     = 'Suite|Ste|Apt|Apartment|Unit|Floor|Fl|Office|Room|Rm|Flat|Plot|Tower|Block|Bldg|Building|Shop|Hse';
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const COUNTRIES_LIST = [
  'United States of America','United States','United Kingdom','United Arab Emirates','South Korea',
  'South Africa','New Zealand','Sri Lanka','Saudi Arabia','India','USA','UK','UAE','Canada','Australia',
  'Germany','France','Netherlands','Belgium','Spain','Italy','Switzerland','Sweden','Singapore','Malaysia',
  'Indonesia','Philippines','Japan','China','Qatar','Kuwait','Oman','Bahrain','Nigeria','Kenya','Brazil',
  'Mexico','Argentina','Russia','Poland','Portugal','Ireland','Scotland','England','Vietnam','Thailand',
  'Pakistan','Bangladesh','Nepal','Maldives','Turkey','Egypt','Greece','Austria','Denmark','Norway','Finland'
];
const COUNTRIES = COUNTRIES_LIST.map(esc).join('|');
const COUNTRIES_SET = new Set(COUNTRIES_LIST.map(c => c.toLowerCase()));

// Indian states / UTs used to gate uncapitalized "city + state" address matches
const INDIAN_STATES_LIST = [
  'uttar pradesh', 'madhya pradesh', 'himachal pradesh', 'andhra pradesh',
  'west bengal', 'tamil nadu', 'maharashtra', 'karnataka', 'telangana',
  'rajasthan', 'chhattisgarh', 'jharkhand', 'uttarakhand', 'gujarat',
  'punjab', 'kerala', 'odisha', 'bihar', 'assam', 'delhi', 'goa', 'haryana'
];
const IN_STATES = INDIAN_STATES_LIST.join('|');

// Locality keywords that strongly signal an Indian street/local address
const LOCALITY_KEYWORD_RE = /\b(?:nagar|colony|sector|road|street|marg|layout|enclave|vihar|gali|chawl|gully|peth|chowk)\b/i;

// Alternation of known Indian/global cities (longest first) for case-insensitive context gating
const KNOWN_CITIES_REGEX = [...KNOWN_CITIES_SET].sort((a, b) => b.length - a.length).map(esc).join('|');

/**
 * True when `text` contains a 6-digit Indian PIN with real address context:
 * a known Indian city right before it, a PIN/Pincode/Postal-code label, or a
 * comma-separated multi-part address containing street/locality keywords.
 * Used to gate whole-line address redaction so HSN codes, quantities and
 * prices containing 6-digit numbers are never treated as addresses.
 */
export function hasIndianPINAddressContext(text) {
  if (!text || !/\b[1-9]\d{2}\s?\d{3}\b/.test(text)) return false;
  const cityPin = new RegExp(String.raw`\b(?:${KNOWN_CITIES_REGEX})\b(?:\s*,\s*(?:${IN_STATES}))?\s*,?\s*[1-9]\d{2}\s?\d{3}\b`, 'gi');
  if (cityPin.test(text)) return true;
  if (/\b(?:pin(?:\s*code)?|pincode|postal(?:\s*code)?)\s*[:#-]?\s*[1-9]\d{2}\s?\d{3}\b/i.test(text)) return true;
  const parts = String(text).split(',');
  const hasLocalityKeyword = parts.some(p => LOCALITY_KEYWORD_RE.test(p));
  const pinPart = parts.some(p => /\b[1-9]\d{2}\s?\d{3}\b/.test(p));
  return hasLocalityKeyword && pinPart;
}

const UPGRADED_ADDRESS_PATTERNS = [
  // A. Number-first streets
  new RegExp(
    String.raw`\b(?!19\d{2}\b|20[0-2]\d\b)(?:` +
      String.raw`\d{1,6}(?:st|nd|rd|th)?[A-Za-z]?|` +
      String.raw`\d{1,5}-\d{1,4}|` +
      String.raw`\d{1,4}(?:\s?/\s?\d{1,4}){1,2}|` +
      String.raw`one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)` +
    String.raw`[\s,]+` +
    String.raw`(?:(?:${DIR})\.?\s+)?` +
    String.raw`(?:[A-Za-z0-9.'\-&]+\s+){1,5}` +
    String.raw`(?:${ST})\.?(?:\s+(?:${DIR})\.?)?\b` +
    String.raw`(?:[\s,#\-]*(?:${UNITS}|#)\s*[A-Za-z0-9/-]{1,10}\.?)?`,
    'gi'),

  // B. Unit-first
  new RegExp(
    String.raw`\b(?:${UNITS})\s*(?:No\.?)?\s*[:#]?\s*[A-Za-z0-9/-]{1,10}` +
    String.raw`[,\s]+(?:\w+\s+){0,3}(?:Rue|Avenue|Boulevard|Street|Road|Drive|Lane|Way|Allée|Platz|Str)\b[^,\n]+`,
    'gi'),

  // C. Indian Style
  new RegExp(
    String.raw`\b(?:Flat|Plot|House|Shop|Office|Suite|Apt|Door)\s*(?:No\.?|#)?\s*[\w\/-]+[,\s]+(?:[\w\s]+(?:Nagar|Colony|Sector|Phase|Enclave|Road|Marg|Street|Layout|Bazaar|Salai|Society|Apartments|Heights|Tower|Residency|Palms|Villa|Gardens|Park))\b`,
    'gi'),

  // D. European street-name-first
  (() => {
    const ends = ['straat','gracht','kade','laan','weg','dreef','singel','markt','plein','burgwal',
      'straße','strasse','gasse','platz','allee','damm','ring','promenade','boulevard','avenue','rue',
      'chemin','impasse','quai','route','allée','place','via','viale','corso','piazza','vicolo','calle',
      'carrera','paseo','glorieta','avinguda','rua','rúa','ulica','prospekt'];
    const E = [...ends, ...ends.map(w => w[0].toUpperCase() + w.slice(1))].map(esc).join('|');
    return new RegExp(String.raw`\b[A-Za-zà-ÿ'’\-]*(?:${E})\b(?:\s+[A-Za-zà-ÿ'’\-]+){0,4}\s+\d{1,4}[A-Za-z]?\b`, 'g');
  })(),

  // E. Indian "No./H.No./D.No." style
  /\b(?:H\.?\s?No\.?|D\.?\s?No\.?|Door\s?No\.?|Plot\s?No\.?|Shop\s?No\.?|Survey\s?No\.?|Sy\.?\s?No\.?)\s*[:.-]?\s*\d+(?:\s?[-/]\s?\d+){0,2}[A-Za-z]?\b/gi,

  // F. PO Boxes
  /\b(?:P\.?\s?O\.?|G\.?\s?P\.?\s?O\.?|Post(?:al)?)\s+Box\b(?:\s*(?:No\.?)?[:#-]?\s*[A-Z0-9-]{2,10}\b)?/gi,

  // G. Ordinal-only streets
  new RegExp(String.raw`\b\d{1,3}(?:st|nd|rd|th)\s+(?:${ST})\b(?:[\s,#\-]*(?:${UNITS}|#)\s*[A-Za-z0-9/-]{1,10})?`, 'gi'),

  // H. Named street without number
  new RegExp(String.raw`\b[A-Z][A-Za-z0-9.'&\-]{1,30}\s+(?:${ST})\.?\b`, 'g'),

  // I. Deterministic City + State / Country / PIN
  new RegExp(String.raw`\b[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){0,2},\s*(?:${US_STATES})\s+\d{5}(?:-\d{4})?\b`, 'g'),
  new RegExp(String.raw`\b[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){0,2}\s+(?:${US_STATES})\s+\d{5}(?:-\d{4})?\b`, 'g'),
  new RegExp(String.raw`\b[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){0,2},\s*(?:${US_STATES})\b`, 'g'),
  new RegExp(String.raw`\b[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){0,2},\s*(?:${COUNTRIES})\b`, 'g'),
  // Indian PIN: a 6-digit number is an address ONLY with real address context — a known
  // Indian city right before it (e.g. "kolkata 700156", "Lucknow, Uttar Pradesh 226010",
  // "Greater Noida, Uttar Pradesh 201310"). Deterministic: city + PIN is a syntactic,
  // high-precision signal. Bare 6-digit numbers (HSN codes, quantities, prices) never match.
  Object.assign(
    new RegExp(String.raw`\b(?:${KNOWN_CITIES_REGEX})\b(?:\s*,\s*(?:${IN_STATES}))?\s*,?\s*[1-9]\d{2}\s?\d{3}\b`, 'gi'),
    { isDeterministic: true }
  ),

  // J. Post codes & PIN codes
  /\b(?:zip(?:\s*code)?|pin(?:\s*code)?|pincode|postal(?:\s*code)?)\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{2,9}\b/gi,
  /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/g, 
  /\b[ABCEGHJ-NPRSTVXY]\d[A-Z][ -]?\d[A-Z]\d\b/g,         
  /\b(?!(?:19|20)\d{2}\b)\d{4}[ \t]+(?=[A-Z][a-zA-Z])/g,

  // K. GPS Coordinates
  /[-+]?\d{1,2}\.\d{4,}\s*°?\s*[NSns]?\s*[,;]\s*[-+]?\d{1,3}\.\d{4,}\s*°?\s*[EWew]?/g,

  // L. Lowercase Indian Localities (meera nath nagar, juhu gully, hsr layout)
  /\b[a-zA-Z0-9.-]{2,20}\s+(?:nagar|colony|society|layout|vihar|enclave|gali|chawl|gully|peth|chowk)\b/gi,

  // M. Uncapitalized Indian City + State pairs (lucknow uttar pradesh, gomti nagar, lucknow)
  // Gated: the token immediately before the state must be a known Indian city, OR the match
  // must contain a digit/comma/locality keyword. Plain phrases like "shop in delhi" or
  // "stay in kerala" never qualify.
  (() => {
    const pattern = new RegExp(String.raw`\b(?:[a-zA-Z\-]+\s+){1,3}(?:${IN_STATES})\b`, 'gi');
    pattern.validator = (matchStr) => {
      if (/[\d,]/.test(matchStr)) return true;             // digit or comma in the match
      if (LOCALITY_KEYWORD_RE.test(matchStr)) return true; // nagar/colony/sector/road/street/...
      const lower = matchStr.trim().toLowerCase();
      const state = INDIAN_STATES_LIST.find(st => {
        if (!lower.endsWith(st)) return false;
        const prevCh = lower[lower.length - st.length - 1];
        return lower.length === st.length || /[\s,]/.test(prevCh);
      });
      if (!state) return false;
      const beforeTokens = lower.slice(0, lower.length - state.length).trim().split(/[\s,]+/).filter(Boolean);
      const prevToken = beforeTokens[beforeTokens.length - 1];
      return typeof prevToken === 'string' && KNOWN_CITIES_SET.has(prevToken);
    };
    return pattern;
  })()
];

function findWordStart(str, query, fromIdx) {
  let idx = fromIdx;
  while (idx < str.length) {
    idx = str.indexOf(query, idx);
    if (idx === -1) return -1;
    if (idx === 0 || !/\w/.test(str[idx - 1])) {
      return idx;
    }
    idx++;
  }
  return -1;
}

function extractNERSpans(rawResults, line) {
  const entities = [];
  let current = null;

  for (const token of rawResults) {
    const isSubword = token.word.startsWith('##');
    const tagType = token.entity.replace(/^[BI]-/, '');

    const minScore = 0.70; 
    if (token.score < minScore) continue;

    const isConsecutive = current && current.tokens.length > 0 &&
      (token.index === current.tokens[current.tokens.length - 1].index + 1);

    if (current && isConsecutive && (isSubword || (token.entity.startsWith('I-') && current.type === tagType))) {
      current.tokens.push(token);
    } else {
      if (current) entities.push(current);
      if (!isSubword) {
        current = { type: tagType, tokens: [token] };
      } else {
        current = null;
      }
    }
  }
  if (current) entities.push(current);

  const spans = [];
  let searchIdx = 0;
  const lineLower = line.toLowerCase();

  for (const ent of entities) {
    const isName = ent.type === 'PER' || ent.type === 'NAME';
    const isAddress = ent.type === 'LOC' || ent.type === 'ADDRESS' || ent.type === 'ADDR';
    if (!isName && !isAddress) continue;

    const meaningfulTokens = ent.tokens.filter(t => !/^[^\w\s]+$/.test(t.word));
    if (meaningfulTokens.length === 0) continue;

    const firstClean = meaningfulTokens[0].word.replace(/^##/, '').toLowerCase();

    let firstIdx = findWordStart(lineLower, firstClean, searchIdx);
    if (firstIdx === -1) continue;

    // Reconstruct the full entity substring by matching tokens SEQUENTIALLY, advancing a
    // cursor through each token in order: subword (##) fragments must continue immediately,
    // whole-word tokens may be separated by whitespace/punctuation. This prevents the last
    // subword fragment (e.g. "h" of "des ##hm ##uk ##h") from matching inside an earlier
    // word and truncating multi-subword surnames like "Sarah Deshmukh" down to "Sarah".
    let cursor = firstIdx + firstClean.length;
    let matched = true;
    for (let i = 1; i < meaningfulTokens.length && matched; i++) {
      const tok = meaningfulTokens[i];
      const frag = tok.word.replace(/^##/, '').toLowerCase();
      if (tok.word.startsWith('##')) {
        // Subword fragment: must continue immediately (no gap allowed)
        if (lineLower.startsWith(frag, cursor)) {
          cursor += frag.length;
        } else {
          matched = false;
        }
      } else {
        // Whole-word token: allow whitespace / punctuation separators in between
        let j = cursor;
        while (j < lineLower.length && j - cursor <= 12 && /[^\w]/.test(lineLower[j])) {
          j++;
        }
        if (lineLower.startsWith(frag, j)) {
          cursor = j + frag.length;
        } else {
          matched = false;
        }
      }
    }
    let endIdx = matched ? cursor : firstIdx + firstClean.length;

    if (isName) {
      const remainder = line.substring(endIdx);
      const hyphenMatch = remainder.match(/^-[A-Za-z]+/);
      if (hyphenMatch) {
        endIdx += hyphenMatch[0].length;
      }
    }

    let extractedText = line.substring(firstIdx, endIdx).trim();
    // Trim accidental trailing or leading punctuation/brackets so tokens don't expand entity boundaries
    const trimmedEnd = extractedText.replace(/[^\w]+$/, '');
    endIdx -= (extractedText.length - trimmedEnd.length);
    extractedText = trimmedEnd;
    const trimmedStart = extractedText.replace(/^[^\w]+/, '');
    firstIdx += (extractedText.length - trimmedStart.length);
    extractedText = trimmedStart;

    const cleanLower = extractedText.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');

    // Skip short tokens (< 3 chars), UI stopwords, strings without alphabets, company/organization names, or country names
    if (
      cleanLower.length < 3 ||
      UI_STOPWORDS.has(cleanLower) ||
      !/[a-zA-Z]/.test(extractedText) ||
      COMPANY_INDICATORS.test(extractedText) ||
      COMPANY_INDICATORS.test(cleanLower) ||
      (isName && COUNTRIES_SET.has(cleanLower))
    ) {
      searchIdx = endIdx;
      continue;
    }

    // Ensure word boundaries: entity must not be a sub-slice inside a single compound word (e.g. "works" in "workspace")
    if (
      (firstIdx > 0 && /\w/.test(line.charAt(firstIdx - 1))) ||
      (endIdx < line.length && /\w/.test(line.charAt(endIdx)))
    ) {
      searchIdx = endIdx;
      continue;
    }

    // Single lowercase English words (e.g. "works", "pace", "compromise") are common vocabulary, not personal names
    if (isName && !extractedText.includes(' ') && extractedText.toLowerCase() === extractedText) {
      searchIdx = endIdx;
      continue;
    }

    // For ADDRESS entities from BERT, ensure there is at least one concrete address/location signal
    // (digits, known city, street/housing keyword, or postal format) so arbitrary phrases (e.g. "her emergency secondary") are never tagged as addresses
    if (isAddress) {
      const hasAddressSignal = /\d/.test(extractedText) ||
        KNOWN_CITIES_SET.has(cleanLower) ||
        STREET_TYPES.some(st => new RegExp(String.raw`\b${esc(st)}\b`, 'i').test(extractedText)) ||
        /\b(?:nagar|colony|sector|block|phase|road|street|avenue|lane|drive|way|layout|enclave|vihar|terrace|springfield|place|square|circle|boulevard|court)\b/i.test(extractedText);
      if (!hasAddressSignal) {
        searchIdx = endIdx;
        continue;
      }
    }

    // Reject amounts or numbers in words (e.g. "INR Twenty-Six Thousand Five Hundred Thirty-Eight") misclassified as ADDRESS or NAME
    const alphaWords = cleanLower.split(/[^a-zA-Z]+/).filter(w => w.length >= 2);
    if (alphaWords.length > 0 && alphaWords.every(w => NUMBER_WORDS.has(w))) {
      searchIdx = endIdx;
      continue;
    }

    // Reject dates and month names (e.g. "Jan", "Jan 29, 2026", "29 Jan 2026", "05-Sep-2026", "Sep-2026", "March 2026", "2026-09-05") misclassified as ADDRESS or NAME
    const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
    const IS_STANDALONE_MONTH = new RegExp(String.raw`^(?:${MONTH_NAMES})$`, 'i');
    const DATE_PATTERN = new RegExp(String.raw`^(?:\d{1,2}[-\/\s,]+)?(?:${MONTH_NAMES})[-\/\s,]*(?:\d{1,2}[-\/\s,]+)?\d{2,4}$|^\d{4}[-\/\s](?:${MONTH_NAMES}|\d{1,2})[-\/\s]\d{1,2}$`, 'i');
    const hasAdjacentDateNumber = new RegExp(String.raw`(?:\b(?:${MONTH_NAMES})\b[\s,.-]*\d{1,4}|\d{1,4}[\s,.-]*\b(?:${MONTH_NAMES})\b)`, 'i').test(line);

    if (IS_STANDALONE_MONTH.test(cleanLower) || DATE_PATTERN.test(cleanLower) || (IS_STANDALONE_MONTH.test(cleanLower) && hasAdjacentDateNumber)) {
      searchIdx = endIdx;
      continue;
    }

    // Reject code identifiers, repo slugs, file paths, or URLs (containing or adjacent to '/' or '_')
    const charBefore = firstIdx > 0 ? line.charAt(firstIdx - 1) : '';
    const charAfter = endIdx < line.length ? line.charAt(endIdx) : '';
    if (
      extractedText.includes('_') ||
      extractedText.includes('/') ||
      charBefore === '/' ||
      charBefore === '_' ||
      charAfter === '/' ||
      charAfter === '_'
    ) {
      searchIdx = endIdx;
      continue;
    }

    // Stopword density check: if >= 50% of words in the phrase are UI stopwords or company keywords, reject as UI chrome
    const words = cleanLower.split(/[\s,&/+-]+/).filter(w => w.length >= 2);
    if (words.length > 0) {
      const stopwordCount = words.filter(w => UI_STOPWORDS.has(w) || COMPANY_INDICATORS.test(w)).length;
      if (stopwordCount / words.length >= 0.50) {
        searchIdx = endIdx;
        continue;
      }
    }

    // Reject document labels and bank branch/kiosk headers from being classified as ADDRESS or NAME
    if (
      /\b(?:Aadhaar|Aadhar|UIDAI|UID|PAN\s*Card|Voter\s*ID|Passport|Driving\s*License|Kendra|Branch|Link\s*Branch|Kiosk|CSP|Gramin\s*Bank)\b/i.test(extractedText) ||
      /\b(?:Kendra|Branch|Link\s*Branch)\b/i.test(line)
    ) {
      searchIdx = endIdx;
      continue;
    }

    let finalTag = isName ? 'NAME' : 'ADDRESS';
    if (isName && KNOWN_CITIES_SET.has(cleanLower)) {
      finalTag = 'ADDRESS';
    }

    // If an entity consisting of phone digits/plus/hyphen was tagged as ADDRESS or NAME, correct it to PHONE
    if (/^(?:\+?\d{1,4}[\s.-]?)?\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}$/.test(extractedText.trim())) {
      finalTag = 'PHONE';
    }

    spans.push({
      tag: finalTag,
      text: extractedText,
      start: firstIdx,
      end: endIdx
    });

    searchIdx = endIdx;
  }

  return spans;
}

/**
 * Executes full hybrid PII Redaction pipeline on raw text.
 * @param {string} rawText - Input sensitive text
 * @returns {Promise<{ cleanedText: string, entities: Array, redactedEntities: Array, count: number, engine: string, timeTaken: number }>}
 */
export async function redactTextContent(rawText, onProgress = null) {
  const startTime = performance.now();
  const { ner, engine } = await getNERPipeline(onProgress);
  const redactions = [];

  const addSpan = (start, end, tag, isDeterministic = false) => {
    const overlaps = [];
    for (let i = 0; i < redactions.length; i++) {
      const r = redactions[i];
      if (Math.max(start, r.start) < Math.min(end, r.end)) {
        overlaps.push(i);
      }
    }

    if (overlaps.length > 0) {
      const hasDeterministic = overlaps.some(idx => redactions[idx].isDeterministic);
      
      // If incoming span is ML/heuristic and overlaps with a deterministic span, do NOT overwrite
      if (!isDeterministic && hasDeterministic) {
        return;
      }

      if (isDeterministic) {
        const remaining = redactions.filter((r, idx) => !overlaps.includes(idx) || r.isDeterministic);
        redactions.length = 0;
        redactions.push(...remaining);
      } else {
        const existing = redactions[overlaps[0]];
        if (start <= existing.start && end >= existing.end && (start < existing.start || end > existing.end)) {
          redactions[overlaps[0]] = { start, end, tag, isDeterministic: false };
        }
        return;
      }
    }

    redactions.push({ start, end, tag, isDeterministic });
  };

  // --- PHASE 1: High-Precision Deterministic Regex Pass ---
  for (const rule of REGEX_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = pattern.exec(rawText)) !== null) {
      if (m[1]) {
        const valStart = m.index + m[0].lastIndexOf(m[1]);
        addSpan(valStart, valStart + m[1].length, rule.tag, true);
      } else {
        addSpan(m.index, m.index + m[0].length, rule.tag, true);
      }
    }
  }

  // --- PHASE 2: Contextual Address, Birthplace & Caps Name Headers ---
  let hm;
  while ((hm = ADDRESS_HEADER_REGEX.exec(rawText)) !== null) {
    const addr = hm[1].trim();
    const start = hm.index + hm[0].indexOf(addr);
    addSpan(start, start + addr.length, 'ADDRESS', true);
  }

  let bm;
  while ((bm = BIRTH_HEADER_REGEX.exec(rawText)) !== null) {
    const place = bm[1].trim();
    const start = bm.index + bm[0].indexOf(place);
    addSpan(start, start + place.length, 'LOCATION', true);
  }

  let cm;
  while ((cm = CAPS_NAME_HEADER_REGEX.exec(rawText)) !== null) {
    const nameStr = cm[1].trim();
    const start = cm.index + cm[0].indexOf(nameStr);
    addSpan(start, start + nameStr.length, 'NAME', true);
  }

  let fnm;
  while ((fnm = FULL_NAME_HEADER_REGEX.exec(rawText)) !== null) {
    const nameStr = fnm[1].trim();
    const start = fnm.index + fnm[0].indexOf(nameStr);
    addSpan(start, start + nameStr.length, 'NAME', true);
  }

  let cnm;
  while ((cnm = CONVERSATIONAL_NAME_REGEX.exec(rawText)) !== null) {
    const nameStr = cnm[1].trim();
    const start = cnm.index + cnm[0].indexOf(nameStr);
    addSpan(start, start + nameStr.length, 'NAME');
  }

  // --- PHASE 3: Upgraded Syntactic Address & Location Detection ---
  const NOT_CITY_PREFIX = /^(?:Invoice|Order|Case|Ticket|Ref|Reference|Reg|Roll|Account|Employee|ID|Transaction|Payment|Amount|Policy|Claim|Serial|Model|Part|Batch|Lot|Page|File|Document|Form|Row|Item|Code|Version|Chapter|Section|Table|Figure|Slide)\b/i;

  for (const pat of UPGRADED_ADDRESS_PATTERNS) {
    const pattern = new RegExp(pat.source, pat.flags);
    let m;
    while ((m = pattern.exec(rawText)) !== null) {
      const matchStr = m[0].trim();
      if (NOT_CITY_PREFIX.test(matchStr) && /\d{5,6}$/.test(matchStr)) {
        continue;
      }
      if (pat.validator && !pat.validator(matchStr)) {
        continue;
      }
      addSpan(m.index, m.index + m[0].length, 'ADDRESS', !!pat.isDeterministic);
    }
  }

  // --- PHASE 4: Semantic NER (MiniLM-L6) for Names & Locations ---
  // EXTENSION PORT: skipped when transformers.js/weights unavailable (regex-only mode).
  if (ner) {
  const lines = rawText.split('\n');
  let lineOffset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const isBrowserChrome = /All Bookmarks|New Tab|Send Anywhere|GeForce NOW|google\.com\/search|\b(?:WhatsApp|Gmail|YouTube)\b.*All Bookmarks/i.test(trimmed) ||
      /^(?:Bleach|Netflix|YouTube|Gmail|WhatsApp)\s+.*(?:Untitled|Watch|Tab)/i.test(trimmed);
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('---') &&
      !trimmed.startsWith('###') &&
      !isBrowserChrome &&
      !SKIP_PATTERNS.test(trimmed)
    ) {
      const rawEnts = await ner(line);
      const nerSpans = extractNERSpans(rawEnts, line);
      for (const s of nerSpans) {
        addSpan(lineOffset + s.start, lineOffset + s.end, s.tag);
      }
    }
    lineOffset += line.length + 1;
  }
  } else {
    console.warn('[PIIDetector] NER skipped (transformers.js unavailable) — deterministic regex only.');
  }

  // --- PHASE 5: Sort, Synthesize & Merge Adjacent / Overlapping Spans ---
  redactions.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of redactions) {
    if (merged.length === 0) {
      merged.push({ ...r });
    } else {
      const last = merged[merged.length - 1];
      if (r.start < last.end) {
        // Spans overlap directly - merge boundary
        last.end = Math.max(last.end, r.end);
        if (last.tag === 'LOCATION' || r.tag === 'ADDRESS') {
          last.tag = 'ADDRESS';
        }
        continue;
      }

      const gap = rawText.substring(last.end, r.start);
      // Clean separator within the same line, or cross-line only if explicitly continued with comma/hyphen
      const isCleanSeparator = !gap.includes('\n')
        ? /^[,\s.\t-]*$/.test(gap)
        : (/^[,\t -]*\n[,\t -]*$/.test(gap) && /[,-\/]\s*$/.test(rawText.substring(0, last.end)));
      
      const isAddressMerge = (last.tag === 'ADDRESS' || last.tag === 'LOCATION') && 
                             (r.tag === 'ADDRESS' || r.tag === 'LOCATION');

      const isSameLineAddressComponent = isAddressMerge &&
        !gap.includes('\n') &&
        gap.length <= 25 &&
        /^[,\s\w-]+$/.test(gap) &&
        !/\b(?:to|and|or|is|was|are|were|between|from)\b/i.test(gap);

      if (isAddressMerge && (isCleanSeparator || isSameLineAddressComponent)) {
        last.tag = 'ADDRESS';
        last.end = Math.max(last.end, r.end);
      } else if (!gap.includes('\n') && isCleanSeparator && gap.length <= 6 && last.tag === r.tag) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }
  }

  // --- PHASE 6: Apply Redactions in Reverse Order ---
  let resultText = rawText;
  const redactedEntities = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end, tag } = merged[i];
    const originalValue = rawText.substring(start, end).trim();
    redactedEntities.unshift({ originalValue, tag, start, end });
    resultText = resultText.substring(0, start) + `[${tag}]` + resultText.substring(end);
  }

  const timeTaken = Math.round(performance.now() - startTime);

  return {
    cleanedText: resultText,
    entities: merged,
    redactedEntities,
    count: merged.length,
    engine,
    timeTaken
  };
}
