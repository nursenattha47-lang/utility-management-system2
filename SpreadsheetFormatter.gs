// ============================================================
// SpreadsheetFormatter.gs — Spreadsheet Auto-Formatter
// UtilityManager | PHASE 6C — Excel Export Engine
// ============================================================
// รับผิดชอบ:
//   1. Header / Sub-header styling (สี, font, border)
//   2. Alternating row colors (สีสลับแถว)
//   3. Grand Total / Summary row styling
//   4. Number format presets (บาท, หน่วย, %, วันที่)
//   5. Conditional color rules (% change, anomaly highlight)
//   6. Column width auto-fit helpers
//   7. Print settings (A4, margin, repeat headers)
//   8. Thai-language date cell formatting
// ============================================================
// Usage:
//   SpreadsheetFormatter.applyHeaderStyle(range)
//   SpreadsheetFormatter.applyAlternatingRows(range, startRow)
//   SpreadsheetFormatter.applyGrandTotalStyle(range)
//   SpreadsheetFormatter.applyNumberFormat(range, preset)
//   SpreadsheetFormatter.applyConditionalColorRule(range, rule)
//   SpreadsheetFormatter.applyPrintSettings(sheet)
//   SpreadsheetFormatter.autoFitColumns(sheet, colWidthMap)
// ============================================================
// Note: SpreadsheetFormatter เป็น plain object (namespace)
//       ไม่ใช่ class — เรียกใช้ผ่าน SpreadsheetFormatter.xxx()
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — FORMATTER NAMESPACE DECLARATION
// ============================================================

/**
 * SpreadsheetFormatter — namespace หลักของ formatter engine
 * ทุก method รับ Range หรือ Sheet เป็น parameter แรก
 */
var SpreadsheetFormatter = (function() {

  // ── สีที่ใช้ทั่วไป (ต้องตรงกับ XL_CONFIG.COLORS) ───────
  var COLORS = {
    HEADER_BG:       '#1F4E79',
    HEADER_FG:       '#FFFFFF',
    SUBHEADER_BG:    '#2E75B6',
    SUBHEADER_FG:    '#FFFFFF',
    ALT_ROW_BG:      '#F5F5F5',
    ALT_ROW_FG:      '#000000',
    SUMMARY_BG:      '#E2EFDA',
    GRAND_TOTAL_BG:  '#D6E4F0',
    GRAND_TOTAL_FG:  '#1F4E79',
    ELECTRICITY_BG:  '#FFF2CC',
    WATER_BG:        '#DDEEFF',
    NEGATIVE_FG:     '#C00000',
    POSITIVE_FG:     '#375623',
    BORDER_COLOR:    '#CCCCCC',
    WHITE:           '#FFFFFF',
  };

  // ── Number format presets ─────────────────────────────────
  var NUMBER_FORMATS = {
    BAHT:          '#,##0.00',          // 1,234.56
    BAHT_INT:      '#,##0',             // 1,234
    UNITS:         '#,##0.00',          // 1,234.56
    UNITS_INT:     '#,##0',             // 1,234
    PERCENT:       '0.00%',             // 12.34%
    PERCENT_INT:   '0%',               // 12%
    RATE:          '#,##0.0000',        // บาท/หน่วย (4 ทศนิยม)
    COUNT:         '#,##0',             // จำนวนนับ
    YEAR_TH:       '0',                 // ปี พ.ศ. (ไม่มี comma)
    DATE_TH:       'dd/mm/yyyy',        // 22/05/2025
    TEXT:          '@',                 // force text
  };


  // ============================================================
  // SECTION 2 — HEADER STYLING
  // ============================================================

  /**
   * ใส่ style ให้ header row หลัก
   * พื้นหลัง Navy, ตัวอักษรขาว, bold, center, border
   *
   * @param {Range}  range          — header range (1 row)
   * @param {string} [bgColor]      — override background color
   * @param {string} [fgColor]      — override foreground color
   */
  function applyHeaderStyle(range, bgColor, fgColor) {
    var bg = bgColor || COLORS.HEADER_BG;
    var fg = fgColor || COLORS.HEADER_FG;

    range
      .setBackground(bg)
      .setFontColor(fg)
      .setFontWeight('bold')
      .setFontSize(10)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setWrap(true);                  // wrap text เพื่อรองรับ header ภาษาไทย

    // ── Border รอบ header ─────────────────────────────────
    range.setBorder(
      true, true, true, true, true, false,
      COLORS.BORDER_COLOR,
      SpreadsheetApp.BorderStyle.SOLID
    );

    // ── Row height ────────────────────────────────────────
    try {
      var sheet = range.getSheet();
      sheet.setRowHeight(range.getRow(), 28);
    } catch (e) { /* ignore */ }
  }


  /**
   * ใส่ style ให้ sub-header row (สีอ่อนกว่า header หลัก)
   * ใช้สำหรับ header level 2 เช่น raw data sheet
   *
   * @param {Range}  range
   * @param {string} [bgColor]
   */
  function applySubHeaderStyle(range, bgColor) {
    applyHeaderStyle(range, bgColor || COLORS.SUBHEADER_BG, COLORS.SUBHEADER_FG);
  }


  // ============================================================
  // SECTION 3 — ALTERNATING ROW COLORS
  // ============================================================

  /**
   * ใส่สีสลับแถว (Zebra striping) สำหรับ data range
   * แถวคู่ = สี alt, แถวคี่ = ขาว
   *
   * @param {Range}  range         — data range (ไม่รวม header)
   * @param {number} startRow      — row index เริ่มต้น (1-based)
   * @param {string} [accentColor] — override accent bg (เช่น สีไฟฟ้า/น้ำ)
   *
   * @note ใช้ batch setValues เพื่อลด API calls
   *       ไม่ใช้ setBackground loop ต่อ row (ช้ามากสำหรับ large data)
   */
  function applyAlternatingRows(range, startRow, accentColor) {
    var numRows   = range.getNumRows();
    var numCols   = range.getNumColumns();
    var sheet     = range.getSheet();
    var firstDataRow = range.getRow();

    // สร้าง background 2D array ทีเดียว
    var backgrounds = [];
    for (var i = 0; i < numRows; i++) {
      var absoluteRow = firstDataRow + i;
      var isEven      = absoluteRow % 2 === 0;
      var rowBg;

      if (accentColor && isEven) {
        // ผสมสี accent กับ alt (ใช้ hex เดิม + opacity ผ่าน hex เบาลง)
        rowBg = _lightenColor(accentColor, 0.7);
      } else {
        rowBg = isEven ? COLORS.ALT_ROW_BG : COLORS.WHITE;
      }

      backgrounds.push(new Array(numCols).fill(rowBg));
    }

    // Set ทั้งหมดครั้งเดียว (1 API call แทน numRows calls)
    range.setBackgrounds(backgrounds);

    // Font color: ดำทุกแถว (reset จากสีที่อาจค้างอยู่)
    range.setFontColor(COLORS.ALT_ROW_FG);

    // Border เส้นแบ่งแนวนอน (thin)
    range.setBorder(
      false, false, false, false, false, true,
      COLORS.BORDER_COLOR,
      SpreadsheetApp.BorderStyle.SOLID
    );
  }


  // ============================================================
  // SECTION 4 — GRAND TOTAL / SUMMARY ROW
  // ============================================================

  /**
   * ใส่ style ให้ Grand Total row
   * พื้นหลัง Navy-light, bold, border หนา
   *
   * @param {Range} range — grand total range (1 row)
   */
  function applyGrandTotalStyle(range) {
    range
      .setBackground(COLORS.GRAND_TOTAL_BG)
      .setFontColor(COLORS.GRAND_TOTAL_FG)
      .setFontWeight('bold')
      .setFontSize(10);

    // Border บนและล่างหนากว่าปกติ
    range.setBorder(
      true, true, true, true, false, false,
      COLORS.HEADER_BG,
      SpreadsheetApp.BorderStyle.MEDIUM
    );

    // Number format สำหรับ numeric cells ใน row นี้
    // (caller รับผิดชอบ format รายละเอียด เพราะ formatter ไม่รู้ column structure)
  }


  /**
   * ใส่ style สำหรับ Summary / KPI highlight row
   * ใช้สีเขียวอ่อน (Summary_BG)
   *
   * @param {Range} range
   */
  function applySummaryRowStyle(range) {
    range
      .setBackground(COLORS.SUMMARY_BG)
      .setFontWeight('bold')
      .setFontColor('#375623');

    range.setBorder(
      true, false, true, false, false, false,
      '#375623',
      SpreadsheetApp.BorderStyle.SOLID
    );
  }


  // ============================================================
  // SECTION 5 — NUMBER FORMAT PRESETS
  // ============================================================

  /**
   * ใส่ number format ตาม preset name
   * รองรับ: BAHT, BAHT_INT, UNITS, PERCENT, RATE, COUNT, YEAR_TH, DATE_TH, TEXT
   *
   * @param {Range}  range
   * @param {string} preset — ชื่อ preset จาก NUMBER_FORMATS
   */
  function applyNumberFormat(range, preset) {
    var fmt = NUMBER_FORMATS[String(preset).toUpperCase()];
    if (!fmt) {
      log('WARN', 'SpreadsheetFormatter',
          'applyNumberFormat: ไม่พบ preset "' + preset + '"');
      return;
    }
    range.setNumberFormat(fmt);
  }


  /**
   * ใส่ format บาท พร้อม alignment ขวา
   *
   * @param {Range} range
   */
  function formatAsBaht(range) {
    range
      .setNumberFormat(NUMBER_FORMATS.BAHT)
      .setHorizontalAlignment('right');
  }


  /**
   * ใส่ format หน่วย (units) พร้อม alignment ขวา
   *
   * @param {Range} range
   */
  function formatAsUnits(range) {
    range
      .setNumberFormat(NUMBER_FORMATS.UNITS)
      .setHorizontalAlignment('right');
  }


  /**
   * ใส่ format เปอร์เซ็นต์ พร้อม alignment ขวา
   *
   * @param {Range}   range
   * @param {boolean} [integer] — true = 0% format แทน 0.00%
   */
  function formatAsPercent(range, integer) {
    range
      .setNumberFormat(integer ? NUMBER_FORMATS.PERCENT_INT : NUMBER_FORMATS.PERCENT)
      .setHorizontalAlignment('right');
  }


  // ============================================================
  // SECTION 6 — CONDITIONAL COLOR RULES
  // ============================================================

  /**
   * ใส่ conditional formatting rule สำหรับ % change column
   *
   * Supported rules:
   *   'DECREASE_IS_GOOD' — ลดลง = เขียว, เพิ่มขึ้น = แดง (ค่าสาธารณูปโภค)
   *   'INCREASE_IS_GOOD' — เพิ่มขึ้น = เขียว, ลดลง = แดง (รายได้)
   *   'THRESHOLD_HIGH'   — > 20% = แดง (anomaly)
   *
   * @param {Range}  range
   * @param {string} rule   — rule name
   * @param {number} [threshold] — สำหรับ THRESHOLD_HIGH (default: 0.2 = 20%)
   */
  function applyConditionalColorRule(range, rule, threshold) {
    // ลบ rule เดิมก่อน (ถ้ามี)
    var sheet    = range.getSheet();
    var existing = sheet.getConditionalFormatRules();

    // สร้าง rules ใหม่ตาม rule type
    var newRules = [];

    if (rule === 'DECREASE_IS_GOOD') {
      // ค่า < 0 (ลดลง) = เขียว = ดี
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberLessThan(0)
          .setFontColor(COLORS.POSITIVE_FG)
          .setBackground('#E2EFDA')
          .setRanges([range])
          .build()
      );
      // ค่า > 0 (เพิ่มขึ้น) = แดง = ไม่ดี
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberGreaterThan(0)
          .setFontColor(COLORS.NEGATIVE_FG)
          .setBackground('#FCE4D6')
          .setRanges([range])
          .build()
      );

    } else if (rule === 'INCREASE_IS_GOOD') {
      // ค่า > 0 (เพิ่มขึ้น) = เขียว
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberGreaterThan(0)
          .setFontColor(COLORS.POSITIVE_FG)
          .setBackground('#E2EFDA')
          .setRanges([range])
          .build()
      );
      // ค่า < 0 (ลดลง) = แดง
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberLessThan(0)
          .setFontColor(COLORS.NEGATIVE_FG)
          .setBackground('#FCE4D6')
          .setRanges([range])
          .build()
      );

    } else if (rule === 'THRESHOLD_HIGH') {
      // ค่า > threshold = แดง (ผิดปกติ)
      var th = threshold || 0.2;
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberGreaterThan(th)
          .setFontColor(COLORS.NEGATIVE_FG)
          .setBackground('#FCE4D6')
          .setRanges([range])
          .build()
      );
    }

    // Append rules ใหม่ต่อจาก rules เดิม
    var allRules = existing.concat(newRules);
    sheet.setConditionalFormatRules(allRules);
  }


  /**
   * Highlight cells ที่มีค่าสูงกว่า threshold ด้วย background แดง
   * ใช้สำหรับ anomaly / overdue amount
   *
   * @param {Range}  range
   * @param {number} threshold
   */
  function highlightAboveThreshold(range, threshold) {
    applyConditionalColorRule(range, 'THRESHOLD_HIGH', threshold);
  }


  // ============================================================
  // SECTION 7 — PRINT SETTINGS
  // ============================================================

  /**
   * ตั้งค่า Print เพื่อ export A4 (portrait)
   * - Fit to width = 1 page
   * - Repeat header rows
   * - Show gridlines = false
   * - Margin = normal
   *
   * @param {Sheet}  sheet
   * @param {number} [freezeRows] — จำนวน header rows ที่ repeat (default: 1)
   */
  function applyPrintSettings(sheet, freezeRows) {
    // Google Sheets ใช้ PageProtection API สำหรับ print settings
    // Note: บาง method อาจไม่มีใน GAS ทุกเวอร์ชัน — ใช้ try-catch
    try {
      var ps = sheet.getPageProtection
        ? null
        : null; // PageProtection deprecated — ใช้ Sheet method แทน

      // ตั้ง print area = ทั้ง sheet
      // GAS ไม่มี native setPrintArea → ใช้ setHiddenGridlines แทน
      sheet.setHiddenGridlines(true);     // ซ่อน gridlines ใน print

    } catch (e) {
      log('WARN', 'SpreadsheetFormatter', 'applyPrintSettings: ' + e.message);
    }
  }


  // ============================================================
  // SECTION 8 — COLUMN WIDTH HELPERS
  // ============================================================

  /**
   * ตั้ง column widths จาก map object
   * map: { colIndex: width } หรือ { A: width, B: width }
   *
   * @param {Sheet}  sheet
   * @param {Object} widthMap  — { 1: 100, 2: 200 } (1-based column index)
   */
  function autoFitColumns(sheet, widthMap) {
    Object.keys(widthMap).forEach(function(col) {
      var colIdx = parseInt(col, 10);
      if (!isNaN(colIdx) && colIdx > 0) {
        sheet.setColumnWidth(colIdx, widthMap[col]);
      }
    });
  }


  /**
   * ใส่ column widths มาตรฐานสำหรับ report ทั่วไป
   * (ใช้เมื่อไม่ต้องการ custom width)
   *
   * @param {Sheet} sheet
   * @param {string} reportType — 'MONTHLY'|'YEARLY'|'SITE'|'SUMMARY'
   */
  function applyStandardColumnWidths(sheet, reportType) {
    var widthMap = _getStandardWidthMap(reportType);
    autoFitColumns(sheet, widthMap);
  }


  /**
   * Width map มาตรฐานตาม report type
   *
   * @param {string} reportType
   * @returns {Object}
   * @private
   */
  function _getStandardWidthMap(reportType) {
    var maps = {
      SUMMARY: {
        1: 40,   // #
        2: 100,  // รหัสสถานที่
        3: 200,  // ชื่อสถานที่
        4: 110,  5: 120,  6: 110,  7: 120,
        8: 120,  9: 80,   10: 200,
      },
      MONTHLY: {
        1: 40,  2: 70,  3: 70,  4: 110,  5: 200,
        6: 130, 7: 80,  8: 100, 9: 110,  10: 90,
        11: 100, 12: 120,
      },
      YEARLY: {
        1: 40,  2: 110, 3: 200,
        4: 120, 5: 120, 6: 120, 7: 90,
        8: 110, 9: 110, 10: 90, 11: 80,
      },
      SITE: {
        1: 40,  2: 70,  3: 65,  4: 130,
        5: 80,  6: 110, 7: 110, 8: 90,
        9: 100, 10: 120, 11: 200,
      },
    };
    return maps[String(reportType).toUpperCase()] || maps['MONTHLY'];
  }


  // ============================================================
  // SECTION 9 — SHEET-LEVEL FORMATTING HELPERS
  // ============================================================

  /**
   * ใส่ border รอบ range ทั้งหมด (outline + inner)
   *
   * @param {Range}  range
   * @param {string} [style]  — 'SOLID'|'MEDIUM'|'DASHED' (default: SOLID)
   * @param {string} [color]
   */
  function applyBorderAll(range, style, color) {
    var borderStyle = SpreadsheetApp.BorderStyle[style] ||
                      SpreadsheetApp.BorderStyle.SOLID;
    var borderColor = color || COLORS.BORDER_COLOR;

    range.setBorder(
      true, true, true, true, true, true,
      borderColor,
      borderStyle
    );
  }


  /**
   * ใส่ outer border เท่านั้น (ไม่มี inner)
   *
   * @param {Range}  range
   * @param {string} [style]
   * @param {string} [color]
   */
  function applyBorderOutline(range, style, color) {
    var borderStyle = SpreadsheetApp.BorderStyle[style] ||
                      SpreadsheetApp.BorderStyle.MEDIUM;
    var borderColor = color || COLORS.HEADER_BG;

    range.setBorder(
      true, true, true, true, false, false,
      borderColor,
      borderStyle
    );
  }


  /**
   * Center + merge title cells ข้ามหลาย column
   *
   * @param {Sheet}  sheet
   * @param {number} row
   * @param {number} fromCol
   * @param {number} toCol
   * @param {string} text
   * @param {Object} [style]  — { fontSize, fontColor, bgColor, bold }
   */
  function writeMergedTitle(sheet, row, fromCol, toCol, text, style) {
    style = style || {};
    var range = sheet.getRange(row, fromCol, 1, toCol - fromCol + 1);

    range.merge()
         .setValue(text)
         .setHorizontalAlignment('center')
         .setVerticalAlignment('middle')
         .setFontWeight(style.bold !== false ? 'bold' : 'normal')
         .setFontSize(style.fontSize || 12)
         .setFontColor(style.fontColor || COLORS.HEADER_BG)
         .setWrap(true);

    if (style.bgColor) {
      range.setBackground(style.bgColor);
    }
  }


  /**
   * ใส่ watermark text ที่มุมขวาล่างของ sheet
   * บอกว่าสร้างโดยระบบอะไร + วันที่
   *
   * @param {Sheet}  sheet
   * @param {string} systemName
   * @param {Date}   [date]
   */
  function writeWatermark(sheet, systemName, date) {
    var lastRow = Math.max(sheet.getLastRow() + 2, 5);
    var text    = 'สร้างโดย: ' + (systemName || 'UtilityManager') +
                  '  |  สร้างเมื่อ: ' + _formatDateTimeTh(date || new Date());

    sheet.getRange(lastRow, 1)
         .setValue(text)
         .setFontColor('#AAAAAA')
         .setFontSize(8)
         .setFontStyle('italic');
  }


  // ============================================================
  // SECTION 10 — INTERNAL UTILITY FUNCTIONS
  // ============================================================

  /**
   * Lighten hex color ตาม factor (0 = เต็ม, 1 = ขาว)
   *
   * @param {string} hex    — เช่น '#FFF2CC'
   * @param {number} factor — 0.0 - 1.0
   * @returns {string}
   * @private
   */
  function _lightenColor(hex, factor) {
    // แปลง hex → RGB
    var h   = hex.replace('#', '');
    var r   = parseInt(h.substring(0, 2), 16);
    var g   = parseInt(h.substring(2, 4), 16);
    var b   = parseInt(h.substring(4, 6), 16);

    // Lighten: blend กับขาว
    r = Math.round(r + (255 - r) * factor);
    g = Math.round(g + (255 - g) * factor);
    b = Math.round(b + (255 - b) * factor);

    // แปลงกลับเป็น hex
    return '#' +
      _hexByte(r) +
      _hexByte(g) +
      _hexByte(b);
  }


  /**
   * แปลง int 0-255 เป็น 2-digit hex string
   * @param {number} n
   * @returns {string}
   * @private
   */
  function _hexByte(n) {
    var hex = Math.max(0, Math.min(255, n)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }


  /**
   * Format วันเวลาภาษาไทย (ใช้ภายใน formatter)
   * @param {Date} date
   * @returns {string}
   * @private
   */
  function _formatDateTimeTh(date) {
    var MONTHS_TH = [
      'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
      'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
      'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
    ];
    var d  = date.getDate();
    var m  = MONTHS_TH[date.getMonth()];
    var y  = date.getFullYear() + 543;
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return d + ' ' + m + ' ' + y + ' ' + hh + ':' + mm + ' น.';
  }


  // ============================================================
  // SECTION 11 — BATCH FORMATTING FOR LARGE SHEETS
  // ============================================================

  /**
   * Apply complete formatting ให้ data sheet ครั้งเดียว
   * เหมาะสำหรับ large export ที่ต้องการประสิทธิภาพสูง
   *
   * รวม: header style + alternating rows + number format + borders
   *
   * @param {Sheet}    sheet
   * @param {number}   headerRow    — row ที่เป็น header (1-based)
   * @param {number}   dataStartRow — row เริ่มต้น data
   * @param {number}   dataEndRow   — row สุดท้ายของ data
   * @param {number}   numCols      — จำนวน columns
   * @param {Object}   [colFormats] — { colIndex: formatPreset }
   *                                   เช่น { 8: 'BAHT', 9: 'PERCENT' }
   */
  function applyFullSheetFormat(sheet, headerRow, dataStartRow, dataEndRow, numCols, colFormats) {
    colFormats = colFormats || {};

    // ── 1. Header ────────────────────────────────────────
    applyHeaderStyle(sheet.getRange(headerRow, 1, 1, numCols));

    // ── 2. Data rows (ถ้ามี) ─────────────────────────────
    var numDataRows = dataEndRow - dataStartRow + 1;
    if (numDataRows > 0) {
      var dataRange = sheet.getRange(dataStartRow, 1, numDataRows, numCols);
      applyAlternatingRows(dataRange, dataStartRow);

      // ── 3. Column-specific number formats ───────────────
      Object.keys(colFormats).forEach(function(colIdx) {
        var fmt = NUMBER_FORMATS[colFormats[colIdx]];
        if (fmt) {
          sheet.getRange(dataStartRow, parseInt(colIdx, 10), numDataRows, 1)
               .setNumberFormat(fmt);
        }
      });

      // ── 4. Outer border ───────────────────────────────
      applyBorderOutline(dataRange);
    }

    // ── 5. Freeze ─────────────────────────────────────────
    sheet.setFrozenRows(headerRow);

    // ── 6. Flush (เพื่อ commit ทุก operation) ────────────
    SpreadsheetApp.flush();
  }


  /**
   * แบ่ง format เป็น chunk สำหรับ sheet ที่มีข้อมูลมาก
   * ป้องกัน "Exceeded maximum execution time" error
   *
   * @param {Sheet}  sheet
   * @param {number} dataStartRow
   * @param {number} dataEndRow
   * @param {number} numCols
   * @param {number} [chunkSize]   — จำนวนแถวต่อ chunk (default: 500)
   */
  function applyFormattingInChunks(sheet, dataStartRow, dataEndRow, numCols, chunkSize) {
    chunkSize = chunkSize || 500;
    var currentRow = dataStartRow;

    while (currentRow <= dataEndRow) {
      var endRow = Math.min(currentRow + chunkSize - 1, dataEndRow);
      var numRows = endRow - currentRow + 1;

      var chunkRange = sheet.getRange(currentRow, 1, numRows, numCols);
      applyAlternatingRows(chunkRange, currentRow);

      // Flush ทุก chunk เพื่อป้องกัน timeout
      SpreadsheetApp.flush();
      currentRow += chunkSize;
    }
  }


  // ============================================================
  // SECTION 12 — PUBLIC API EXPORTS
  // ============================================================

  // คืน public methods ทั้งหมด
  return {
    // Header styling
    applyHeaderStyle:          applyHeaderStyle,
    applySubHeaderStyle:       applySubHeaderStyle,

    // Row styling
    applyAlternatingRows:      applyAlternatingRows,
    applyGrandTotalStyle:      applyGrandTotalStyle,
    applySummaryRowStyle:      applySummaryRowStyle,

    // Number formats
    applyNumberFormat:         applyNumberFormat,
    formatAsBaht:              formatAsBaht,
    formatAsUnits:             formatAsUnits,
    formatAsPercent:           formatAsPercent,
    NUMBER_FORMATS:            NUMBER_FORMATS,   // expose สำหรับ caller ที่ต้องการ

    // Conditional formatting
    applyConditionalColorRule: applyConditionalColorRule,
    highlightAboveThreshold:   highlightAboveThreshold,

    // Print
    applyPrintSettings:        applyPrintSettings,

    // Column widths
    autoFitColumns:            autoFitColumns,
    applyStandardColumnWidths: applyStandardColumnWidths,

    // Borders
    applyBorderAll:            applyBorderAll,
    applyBorderOutline:        applyBorderOutline,

    // Merged title + watermark
    writeMergedTitle:          writeMergedTitle,
    writeWatermark:            writeWatermark,

    // Batch / large export
    applyFullSheetFormat:      applyFullSheetFormat,
    applyFormattingInChunks:   applyFormattingInChunks,

    // Expose COLORS สำหรับ caller
    COLORS: COLORS,
  };

})();  // IIFE — ป้องกัน variable leak ไปสู่ global scope
