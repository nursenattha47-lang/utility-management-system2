// ============================================================
// TemplateMatcher.gs — Provider Detection & Regex Field Extraction
// UtilityManager | PHASE 3 — PDF Parser Module
// ============================================================
// รับผิดชอบ:
//   - ตรวจจับ Provider จากเนื้อหา PDF (PEA / MEA / PWA / MWA / ...)
//   - ใช้ Regex Template ที่เหมาะสมกับแต่ละ Provider
//   - สกัด fields ทั้งหมดจากข้อความ
//   - คำนวณ Field-level Confidence Score
//   - รองรับการเพิ่ม Provider ใหม่ในอนาคต
// ============================================================
// Dependencies: Config.gs, Utils.gs
// ============================================================
// วิธีเพิ่ม Provider ใหม่:
//   1. เพิ่ม entry ใน PROVIDER_SIGNATURES
//   2. เพิ่ม template ใน BILL_TEMPLATES
//   3. เพิ่ม field weights ใน FIELD_WEIGHTS (ถ้า fields ต่างกัน)
//   ไม่ต้องแก้ไข matchAndExtractFields() หรือ detectProvider()
// ============================================================


// ============================================================
// SECTION 1 — PROVIDER SIGNATURES
// keyword/pattern ที่ใช้ระบุว่า PDF มาจาก Provider ใด
// ============================================================

/**
 * Signature ของแต่ละ Provider
 * keywords: ถ้าพบคำเหล่านี้ในข้อความ → น่าจะเป็น Provider นี้
 * patterns: regex เพิ่มเติมสำหรับกรณีพิเศษ
 * weight: น้ำหนักความสำคัญ (ใช้เมื่อมี keywords หลาย Provider ปรากฏพร้อมกัน)
 */
const PROVIDER_SIGNATURES = {

  PEA: {
    name:     'การไฟฟ้าส่วนภูมิภาค (PEA)',
    type:     'ELECTRICITY',
    keywords: [
      'การไฟฟ้าส่วนภูมิภาค',
      'Provincial Electricity Authority',
      'PEA',
    ],
    patterns: [
      /\bPEA\b/,
      /การไฟฟ้าส่วนภูมิภาค/,
    ],
    weight: 100,
  },

  MEA: {
    name:     'การไฟฟ้านครหลวง (MEA)',
    type:     'ELECTRICITY',
    keywords: [
      'การไฟฟ้านครหลวง',
      'Metropolitan Electricity Authority',
      'MEA',
    ],
    patterns: [
      /\bMEA\b/,
      /การไฟฟ้านครหลวง/,
    ],
    weight: 100,
  },

  PWA: {
    name:     'การประปาส่วนภูมิภาค (PWA)',
    type:     'WATER',
    keywords: [
      'การประปาส่วนภูมิภาค',
      'Provincial Waterworks Authority',
      'PWA',
    ],
    patterns: [
      /\bPWA\b/,
      /การประปาส่วนภูมิภาค/,
    ],
    weight: 100,
  },

  MWA: {
    name:     'การประปานครหลวง (MWA)',
    type:     'WATER',
    keywords: [
      'การประปานครหลวง',
      'Metropolitan Waterworks Authority',
      'MWA',
    ],
    patterns: [
      /\bMWA\b/,
      /การประปานครหลวง/,
    ],
    weight: 100,
  },

  PTT: {
    name:     'ปตท. (PTT)',
    type:     'GAS',
    keywords: [
      'ปตท',
      'บริษัท ปตท',
      'PTT',
    ],
    patterns: [/\bPTT\b/, /ปตท/],
    weight: 80,
  },

  // ---- เพิ่ม Provider ใหม่ที่นี่ ----
  // EXAMPLE_ISP: {
  //   name:     'ชื่อ ISP',
  //   type:     'INTERNET',
  //   keywords: ['ชื่อบริษัท', 'ชื่อย่อ'],
  //   patterns: [/pattern/],
  //   weight: 90,
  // },
};


// ============================================================
// SECTION 2 — BILL TEMPLATES (Regex Patterns)
// แต่ละ Provider มี Template ของตัวเอง
// ============================================================

/**
 * Template Regex สำหรับแต่ละ Provider
 *
 * โครงสร้างของแต่ละ pattern:
 * {
 *   regex:    RegExp   — pattern หลัก
 *   group:    number   — capture group index (default: 1)
 *   postProcess: fn    — ฟังก์ชัน transform ผลที่ได้ (optional)
 *   weight:   number   — น้ำหนักสำหรับ confidence (0-30)
 *   required: boolean  — field นี้ต้องได้ค่าถึงจะผ่าน
 * }
 */
const BILL_TEMPLATES = {

  // ============================================================
  // PEA — การไฟฟ้าส่วนภูมิภาค
  // ============================================================
  PEA: {
    // เลขที่ผู้ใช้ไฟ / เลขมิเตอร์
    meter_number: {
      regex:    /(?:เลขที่ผู้ใช้ไฟ|เลขมิเตอร์|CA Number|Meter Serial)[:\s#]*([0-9\s\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.replace(/\s+/g, '').trim(),
      weight:   25,
      required: false,
    },

    // หน่วยก่อน (previous reading)
    units_before: {
      regex:    /(?:หน่วยก่อน|เลขก่อน|ยอดก่อน|Previous)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    // หน่วยหลัง (current reading)
    units_after: {
      regex:    /(?:หน่วยหลัง|เลขหลัง|ยอดหลัง|Current)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    // จำนวนหน่วยที่ใช้
    units_used: {
      regex:    /(?:จำนวนหน่วย|หน่วยที่ใช้|Units Used|หน่วยรวม)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   20,
      required: false,
    },

    // ยอดรวมทั้งหมด (field ที่สำคัญที่สุด)
    amount_total: {
      regex:    /(?:ยอดรวม|รวมทั้งหมด|จำนวนเงิน|เงินรวม|Total Amount|NET AMOUNT|รวมเงิน)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   30,
      required: true,
    },

    // ค่าไฟฟ้าฐาน
    amount_base: {
      regex:    /(?:ค่าไฟฟ้า|ค่าพลังงาน|Energy Charge)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   10,
      required: false,
    },

    // ค่า Ft
    amount_ft: {
      regex:    /(?:ค่า\s*Ft|Ft\s*ต่อหน่วย.*?รวม|ค่าปรับ\s*Ft)[:\s]*(-?[\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   5,
      required: false,
    },

    // ภาษีมูลค่าเพิ่ม 7%
    amount_vat: {
      regex:    /(?:ภาษีมูลค่าเพิ่ม|VAT|ภาษี\s*7%)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   5,
      required: false,
    },

    // วันกำหนดชำระ
    due_date: {
      regex:    /(?:กำหนดชำระ|วันครบกำหนด|Due Date|ชำระภายใน)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   15,
      required: false,
    },

    // เดือนที่ออกบิล
    bill_month_text: {
      regex:    /(?:ประจำเดือน|เดือน)[:\s]*([ก-ฮ]+(?:คม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม))/,
      group:    1,
      postProcess: thaiMonthToNumber,
      weight:   20,
      required: false,
    },

    // ปีที่ออกบิล (พ.ศ.)
    bill_year_text: {
      regex:    /(?:ประจำเดือน|เดือน|ปี)[:\s]*[ก-ฮ]*\s*(25\d{2})/,
      group:    1,
      postProcess: (v) => parseInt(v),
      weight:   20,
      required: false,
    },

    // วันที่อ่านมิเตอร์ ต้น
    reading_date_from: {
      regex:    /(?:วันอ่านครั้งก่อน|อ่านมิเตอร์ก่อน)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },

    // วันที่อ่านมิเตอร์ ปลาย
    reading_date_to: {
      regex:    /(?:วันอ่านครั้งนี้|อ่านมิเตอร์หลัง|วันอ่านล่าสุด)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },

    // เลขที่สัญญา / เลขที่ผู้ใช้
    contract_number: {
      regex:    /(?:เลขที่สัญญา|หมายเลขผู้ใช้|Customer ID)[:\s]*([A-Z0-9\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.trim().toUpperCase(),
      weight:   5,
      required: false,
    },
  },

  // ============================================================
  // MEA — การไฟฟ้านครหลวง
  // Pattern ส่วนใหญ่เป็นภาษาอังกฤษมากกว่า PEA
  // ============================================================
  MEA: {
    meter_number: {
      regex:    /(?:Meter\s*(?:No|Number|Serial)[.:\s#]*|เลขมิเตอร์[:\s]*)([0-9\s]{5,20})/i,
      group:    1,
      postProcess: (v) => v.replace(/\s+/g, '').trim(),
      weight:   25,
      required: false,
    },

    units_before: {
      regex:    /(?:Previous\s*Reading|หน่วยก่อน)[:\s]*([\d,]+(?:\.\d)?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_after: {
      regex:    /(?:Present\s*Reading|Current\s*Reading|หน่วยหลัง)[:\s]*([\d,]+(?:\.\d)?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_used: {
      regex:    /(?:Units?\s*Consumed|Units?\s*Used|จำนวนหน่วย)[:\s]*([\d,]+(?:\.\d)?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   20,
      required: false,
    },

    amount_total: {
      regex:    /(?:NET\s*AMOUNT|Total\s*Amount|ยอดรวม|TOTAL)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   30,
      required: true,
    },

    amount_base: {
      regex:    /(?:Energy\s*Charge|ค่าพลังงาน)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   10,
      required: false,
    },

    amount_ft: {
      regex:    /(?:Ft\s*Charge|Fuel\s*Adjustment)[:\s]*(-?[\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   5,
      required: false,
    },

    amount_vat: {
      regex:    /(?:VAT|Value\s*Added\s*Tax)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   5,
      required: false,
    },

    due_date: {
      regex:    /(?:DUE\s*DATE|Due\s*by|Payment\s*Due)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   15,
      required: false,
    },

    bill_month_text: {
      regex:    /(?:Billing\s*Period|Bill\s*Month)[:\s]*(?:\w+)\s+(\w+)\s+(20\d{2})/i,
      group:    1,
      postProcess: englishMonthToNumber,
      weight:   15,
      required: false,
    },

    bill_year_text: {
      regex:    /(?:Billing\s*Period|Bill\s*Month)[:\s]*\w+\s+\w+\s+(20\d{2})/i,
      group:    1,
      // MEA ใช้ ค.ศ. → แปลงเป็น พ.ศ.
      postProcess: (v) => parseInt(v) + 543,
      weight:   15,
      required: false,
    },

    reading_date_from: {
      regex:    /(?:Reading\s*From|Previous\s*Date)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },

    reading_date_to: {
      regex:    /(?:Reading\s*To|Current\s*Date|Present\s*Date)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },

    contract_number: {
      regex:    /(?:Customer\s*(?:No|ID|Number)[.:\s#]*|CA\s*Number[:\s]*)([A-Z0-9\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.trim().toUpperCase(),
      weight:   5,
      required: false,
    },
  },

  // ============================================================
  // PWA — การประปาส่วนภูมิภาค
  // ============================================================
  PWA: {
    meter_number: {
      regex:    /(?:เลขมิเตอร์|หมายเลขมิเตอร์|Meter\s*No)[.:\s#]*([0-9\s\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.replace(/\s+/g, '').trim(),
      weight:   25,
      required: false,
    },

    units_before: {
      regex:    /(?:ยอดมิเตอร์ก่อน|หน่วยก่อน|ค่าก่อน)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_after: {
      regex:    /(?:ยอดมิเตอร์หลัง|หน่วยหลัง|ค่าหลัง)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_used: {
      regex:    /(?:ปริมาณน้ำที่ใช้|จำนวนหน่วย|หน่วยน้ำ)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   20,
      required: false,
    },

    amount_total: {
      regex:    /(?:ยอดรวม|จำนวนเงินทั้งสิ้น|รวมค่าน้ำ|เงินรวม)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   30,
      required: true,
    },

    amount_base: {
      regex:    /(?:ค่าน้ำประปา|ค่าใช้น้ำ)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    amount_vat: {
      regex:    /(?:ภาษีมูลค่าเพิ่ม|VAT)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   5,
      required: false,
    },

    due_date: {
      regex:    /(?:กำหนดชำระ|ชำระภายใน|วันครบกำหนด)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   15,
      required: false,
    },

    bill_month_text: {
      regex:    /(?:ประจำเดือน|เดือน)[:\s]*([ก-ฮ]+(?:คม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม))/,
      group:    1,
      postProcess: thaiMonthToNumber,
      weight:   20,
      required: false,
    },

    bill_year_text: {
      regex:    /(?:ประจำเดือน|เดือน|ปี)[:\s]*[ก-ฮ]*\s*(25\d{2})/,
      group:    1,
      postProcess: (v) => parseInt(v),
      weight:   20,
      required: false,
    },

    reading_date_from: {
      regex:    /(?:อ่านครั้งก่อน|วันอ่านก่อน)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },

    reading_date_to: {
      regex:    /(?:อ่านครั้งนี้|วันอ่านหลัง|วันอ่านล่าสุด)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   5,
      required: false,
    },
  },

  // ============================================================
  // MWA — การประปานครหลวง
  // ============================================================
  MWA: {
    meter_number: {
      regex:    /(?:Meter\s*No|เลขมิเตอร์)[.:\s#]*([0-9\s\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.replace(/\s+/g, '').trim(),
      weight:   25,
      required: false,
    },

    units_before: {
      regex:    /(?:Previous|ก่อน)[:\s]*([\d,]+)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_after: {
      regex:    /(?:Present|Current|หลัง)[:\s]*([\d,]+)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    units_used: {
      regex:    /(?:Units?\s*(?:Used|Consumed)|จำนวน(?:น้ำ|หน่วย))[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   20,
      required: false,
    },

    amount_total: {
      regex:    /(?:Total|NET|ยอดรวม|จำนวนเงิน)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   30,
      required: true,
    },

    due_date: {
      regex:    /(?:Due\s*Date|DUE|กำหนดชำระ)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   15,
      required: false,
    },

    bill_month_text: {
      regex:    /(?:Billing\s*Period|ประจำเดือน)[:\s]*(?:\d{1,2}\/)?(\w+)\s*((?:20|25)\d{2})/i,
      group:    1,
      postProcess: (v) => v.includes('/') ? parseInt(v.split('/')[0]) : englishMonthToNumber(v),
      weight:   20,
      required: false,
    },

    bill_year_text: {
      regex:    /(?:Billing\s*Period|ประจำเดือน)[:\s]*\S+\s+((?:20|25)\d{2})/i,
      group:    1,
      postProcess: (v) => {
        const y = parseInt(v);
        // ถ้าเป็น ค.ศ. ให้แปลงเป็น พ.ศ.
        return y < 2500 ? y + 543 : y;
      },
      weight:   20,
      required: false,
    },
  },

  // ============================================================
  // Generic / Fallback Template
  // ใช้เมื่อระบุ Provider ไม่ได้
  // ============================================================
  GENERIC: {
    meter_number: {
      regex:    /(?:มิเตอร์|Meter)[:\s#.]*([0-9\s\-]{5,20})/i,
      group:    1,
      postProcess: (v) => v.replace(/\s+/g, '').trim(),
      weight:   20,
      required: false,
    },

    units_used: {
      regex:    /(?:หน่วย|Units?)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   15,
      required: false,
    },

    amount_total: {
      regex:    /(?:ยอดรวม|Total|รวม|จำนวนเงิน)[:\s]*([\d,]+(?:\.\d{1,2})?)/i,
      group:    1,
      postProcess: parseThaiNumber,
      weight:   30,
      required: true,
    },

    due_date: {
      regex:    /(?:กำหนด|Due)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      group:    1,
      postProcess: normalizeDateStr,
      weight:   15,
      required: false,
    },

    bill_month_text: {
      regex:    /(?:เดือน|Month)[:\s]*([ก-ฮ]+(?:คม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)|\w+)/,
      group:    1,
      postProcess: (v) => thaiMonthToNumber(v) || englishMonthToNumber(v),
      weight:   20,
      required: false,
    },

    bill_year_text: {
      regex:    /(25\d{2})/,
      group:    1,
      postProcess: (v) => parseInt(v),
      weight:   20,
      required: false,
    },
  },
};


// ============================================================
// SECTION 3 — PROVIDER DETECTION
// ============================================================

/**
 * ระบุ Provider จากข้อความ PDF
 *
 * @param {string} text  — raw text จาก PDF
 * @returns {{ provider: string, providerName: string, confidence: number, matchedKeywords: string[] }}
 */
function detectProvider(text) {
  if (!text) {
    return { provider: 'GENERIC', providerName: 'ไม่ทราบ', confidence: 0, matchedKeywords: [] };
  }

  const normalizedText = text.toUpperCase();
  const scores = {};

  // นับ keyword matches สำหรับแต่ละ Provider
  for (const [provider, sig] of Object.entries(PROVIDER_SIGNATURES)) {
    let score    = 0;
    const matched = [];

    // ตรวจ keywords (case-insensitive)
    for (const keyword of sig.keywords) {
      if (text.includes(keyword) || normalizedText.includes(keyword.toUpperCase())) {
        score += sig.weight;
        matched.push(keyword);
        break; // นับแค่ครั้งแรกที่เจอ keyword ของ provider นั้น
      }
    }

    // ตรวจ regex patterns เพิ่มเติม
    if (score === 0) {
      for (const pattern of (sig.patterns || [])) {
        if (pattern.test(text)) {
          score += sig.weight * 0.5; // น้ำหนักน้อยกว่า keyword match
          matched.push(pattern.toString());
          break;
        }
      }
    }

    if (score > 0) {
      scores[provider] = { score, matched };
    }
  }

  // ถ้าไม่เจอเลย → GENERIC
  if (Object.keys(scores).length === 0) {
    log('WARN', 'detectProvider', 'ไม่สามารถระบุ Provider จาก text ได้');
    return { provider: 'GENERIC', providerName: 'ไม่ทราบ', confidence: 30, matchedKeywords: [] };
  }

  // เลือก provider ที่มี score สูงสุด
  const best = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[0];
  const [provider, { score, matched }] = best;

  // คำนวณ confidence (0-100)
  // score === weight ของ provider → confidence 100%
  const maxPossible = PROVIDER_SIGNATURES[provider].weight;
  const confidence  = Math.min(100, Math.round((score / maxPossible) * 100));

  log('INFO', 'detectProvider', `Detected: ${provider} (confidence: ${confidence}%, keywords: ${matched.join(', ')})`);

  return {
    provider,
    providerName:    PROVIDER_SIGNATURES[provider]?.name || provider,
    confidence,
    matchedKeywords: matched,
  };
}


// ============================================================
// SECTION 4 — FIELD EXTRACTION
// ============================================================

/**
 * ใช้ Template ของ Provider สกัด fields ทั้งหมดจากข้อความ
 *
 * @param {string} text       — raw text จาก PDF
 * @param {string} provider   — provider code ('PEA', 'MEA', ...)
 * @param {Object} meter      — meter object (ใช้ cross-check บางกรณี)
 * @returns {{ fields: Object, confidenceScore: number, warnings: string[], missingRequired: string[] }}
 */
function matchAndExtractFields(text, provider, meter) {
  // เลือก template (ถ้าไม่มีให้ใช้ GENERIC)
  const template = BILL_TEMPLATES[provider] || BILL_TEMPLATES.GENERIC;

  const extractedFields  = {};
  const warnings         = [];
  const missingRequired  = [];
  let   totalWeight      = 0;
  let   achievedWeight   = 0;

  // วน loop สกัดแต่ละ field
  for (const [fieldName, config] of Object.entries(template)) {
    totalWeight += config.weight || 0;

    const rawValue = _extractField(text, config);

    if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
      achievedWeight += config.weight || 0;

      // เก็บทั้ง raw และ processed value
      extractedFields[fieldName] = rawValue;

    } else if (config.required) {
      missingRequired.push(fieldName);
      warnings.push(`ไม่พบ field สำคัญ: ${fieldName}`);
    }
  }

  // Post-process: แปลง bill_month_text และ bill_year_text เป็น bill_month, bill_year
  _normalizeBillPeriod(extractedFields);

  // คำนวณ confidence score จาก field extraction
  const confidenceScore = totalWeight > 0
    ? Math.round((achievedWeight / totalWeight) * 100)
    : 0;

  log('INFO', 'matchAndExtractFields',
    `Provider: ${provider} | Fields: ${Object.keys(extractedFields).length} | Score: ${confidenceScore}%`
  );

  return {
    fields:          extractedFields,
    confidenceScore,
    warnings,
    missingRequired,
  };
}

/**
 * สกัดค่าของ 1 field จาก text โดยใช้ config ของ field นั้น
 * ลอง patterns หลายแบบ รวมถึง multi-line
 *
 * @param {string} text
 * @param {Object} fieldConfig
 * @returns {*} ค่าที่สกัดได้ (ผ่าน postProcess แล้ว) หรือ null
 * @private
 */
function _extractField(text, fieldConfig) {
  const { regex, group = 1, postProcess } = fieldConfig;

  // ---- ลอง match โดยตรงก่อน ----
  let match = text.match(regex);

  // ---- ถ้าไม่ได้ ลอง normalize text (ลบ line break ส่วนเกิน) ----
  if (!match) {
    const flatText = text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ');
    match = flatText.match(regex);
  }

  if (!match || !match[group]) return null;

  const rawValue = match[group].trim();
  if (!rawValue) return null;

  // Apply postProcess ถ้ามี
  try {
    return postProcess ? postProcess(rawValue) : rawValue;
  } catch (e) {
    log('WARN', '_extractField', `postProcess failed for value "${rawValue}": ${e.message}`);
    return rawValue; // คืน raw ถ้า postProcess พัง
  }
}

/**
 * แปลง bill_month_text + bill_year_text → bill_month + bill_year
 * และลบ field ชั่วคราวทิ้ง
 * @private
 */
function _normalizeBillPeriod(fields) {
  // bill_month
  if (fields.bill_month_text !== undefined && fields.bill_month_text !== null) {
    const m = parseInt(fields.bill_month_text);
    if (m >= 1 && m <= 12) fields.bill_month = m;
    delete fields.bill_month_text;
  }

  // bill_year
  if (fields.bill_year_text !== undefined && fields.bill_year_text !== null) {
    const y = parseInt(fields.bill_year_text);
    if (y >= 2560 && y <= 2599) fields.bill_year = y;
    delete fields.bill_year_text;
  }
}


// ============================================================
// SECTION 5 — POST-PROCESSING HELPERS
// ============================================================

/**
 * แปลงตัวเลขไทย/อังกฤษที่อาจมี comma เป็น float
 * เช่น "1,234.56" → 1234.56
 */
function parseThaiNumber(str) {
  if (str === null || str === undefined) return 0;
  const cleaned = String(str).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * แปลงชื่อเดือนภาษาไทยเป็นตัวเลข (1-12)
 */
function thaiMonthToNumber(monthStr) {
  const THAI_MONTHS = {
    'มกราคม':    1, 'ม.ค.': 1,
    'กุมภาพันธ์': 2, 'ก.พ.': 2,
    'มีนาคม':    3, 'มี.ค.': 3,
    'เมษายน':    4, 'เม.ย.': 4,
    'พฤษภาคม':   5, 'พ.ค.': 5,
    'มิถุนายน':  6, 'มิ.ย.': 6,
    'กรกฎาคม':   7, 'ก.ค.': 7,
    'สิงหาคม':   8, 'ส.ค.': 8,
    'กันยายน':   9, 'ก.ย.': 9,
    'ตุลาคม':   10, 'ต.ค.': 10,
    'พฤศจิกายน': 11, 'พ.ย.': 11,
    'ธันวาคม':  12, 'ธ.ค.': 12,
  };

  if (!monthStr) return null;
  const trimmed = monthStr.trim();

  // ลอง exact match ก่อน
  if (THAI_MONTHS[trimmed] !== undefined) return THAI_MONTHS[trimmed];

  // ลอง partial match
  for (const [name, num] of Object.entries(THAI_MONTHS)) {
    if (trimmed.includes(name) || name.includes(trimmed)) return num;
  }

  return null;
}

/**
 * แปลงชื่อเดือนภาษาอังกฤษเป็นตัวเลข (1-12)
 */
function englishMonthToNumber(monthStr) {
  const EN_MONTHS = {
    'january': 1, 'jan': 1,
    'february': 2, 'feb': 2,
    'march': 3, 'mar': 3,
    'april': 4, 'apr': 4,
    'may': 5,
    'june': 6, 'jun': 6,
    'july': 7, 'jul': 7,
    'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10,
    'november': 11, 'nov': 11,
    'december': 12, 'dec': 12,
  };

  if (!monthStr) return null;
  const lower = monthStr.trim().toLowerCase();
  return EN_MONTHS[lower] || null;
}

/**
 * Normalize วันที่จากหลายรูปแบบเป็น ISO 8601 (YYYY-MM-DD)
 * รองรับ: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (ทั้ง ค.ศ. และ พ.ศ.)
 */
function normalizeDateStr(dateStr) {
  if (!dateStr) return '';

  const parts = dateStr.split(/[\/\-\.]/);
  if (parts.length !== 3) return dateStr;

  let [d, m, y] = parts.map(p => parseInt(p.trim()));

  // ตรวจว่า format เป็น MM/DD/YYYY หรือ DD/MM/YYYY
  // ถ้า d > 12 → น่าจะเป็น DD/MM/YYYY แน่นอน
  // ถ้า d <= 12 → อาจเป็นได้ทั้งสองแบบ → default เป็น DD/MM/YYYY (ไทยใช้มากกว่า)
  if (isNaN(d) || isNaN(m) || isNaN(y)) return dateStr;

  // แปลง พ.ศ. → ค.ศ. ถ้า year >= 2500
  if (y >= 2500) y = y - 543;

  // เติม century ถ้า year มี 2 หลัก
  if (y < 100) y = y + 2000;

  // สร้าง ISO date string
  const month = String(m).padStart(2, '0');
  const day   = String(d).padStart(2, '0');

  return `${y}-${month}-${day}`;
}


// ============================================================
// SECTION 6 — TEMPLATE MANAGEMENT
// (สำหรับ Admin ที่ต้องการดู/ทดสอบ templates)
// ============================================================

/**
 * ดึงรายชื่อ Provider ที่รองรับทั้งหมด
 * ใช้สร้าง dropdown ใน UI
 *
 * @returns {{ code: string, name: string, type: string }[]}
 */
function templateGetSupportedProviders() {
  return Object.entries(PROVIDER_SIGNATURES).map(([code, sig]) => ({
    code,
    name: sig.name,
    type: sig.type,
  }));
}

/**
 * ทดสอบ template กับ text ตัวอย่าง (ใช้ใน Admin / Debug)
 *
 * @param {string} provider   — provider code
 * @param {string} sampleText — ข้อความตัวอย่าง
 * @returns {Object} ผลการ parse พร้อม confidence
 */
function templateTest(provider, sampleText) {
  const result = matchAndExtractFields(sampleText, provider, {});
  return {
    provider,
    ...result,
    detectedProvider: detectProvider(sampleText),
  };
}

/**
 * ดึง fields ทั้งหมดของ template (ใช้ debug)
 *
 * @param {string} provider
 * @returns {string[]} list of field names
 */
function templateGetFields(provider) {
  const template = BILL_TEMPLATES[provider] || BILL_TEMPLATES.GENERIC;
  return Object.entries(template).map(([name, config]) => ({
    name,
    required:  config.required || false,
    weight:    config.weight   || 0,
  }));
}
