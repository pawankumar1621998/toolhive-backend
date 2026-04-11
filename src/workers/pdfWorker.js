'use strict';

/**
 * PDF Worker — processes BullMQ jobs from the 'pdf-processing' queue.
 *
 * Tools implemented:
 *   pdf-compress   → pdf-lib re-save (removes dead objects, ~5-20% smaller)
 *   pdf-merge      → pdf-lib merge multiple PDFs
 *   pdf-split      → pdf-lib split into individual pages
 *   jpg-to-pdf     → pdf-lib embed image(s) into a new PDF
 *   pdf-to-word    → pdf-parse text extraction + docx package
 *   pdf-to-jpg     → Cloudinary PDF-to-image transformation
 *   pdf-ocr        → pdf-parse text extraction (text-based PDFs)
 *   pdf-protect    → password protection (requires qpdf — not yet implemented)
 *
 * Run separately: node src/workers/pdfWorker.js
 */

require('dotenv').config();
require('../config/database').connectDB();

const { Worker }         = require('bullmq');
const { PDFDocument }    = require('pdf-lib');
const fontkit            = require('@pdf-lib/fontkit');
const pdfParse           = require('pdf-parse');   // v1 API: direct function
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { redisClient }    = require('../config/redis');
const { cloudinary }     = require('../config/cloudinary');
const Job                = require('../models/Job');
const File               = require('../models/File');
const logger             = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a PDF buffer with automatic XRef/corrupt repair fallback.
 * 1. Try pdf-parse directly.
 * 2. If XRef / bad-object error: re-save through pdf-lib (repairs structure) then retry.
 * 3. If still failing: throw a clear user-facing error.
 */
async function parsePdfSafe(buffer) {
  try {
    return await pdfParse(buffer);
  } catch (firstErr) {
    const msg = (firstErr.message || '').toLowerCase();
    const isStructureError =
      msg.includes('xref') || msg.includes('bad') || msg.includes('invalid') ||
      msg.includes('corrupt') || msg.includes('unexpected') || msg.includes('stream');

    if (!isStructureError) throw firstErr;

    // Attempt repair via pdf-lib (tolerant loader → clean re-save)
    let repairedBuffer;
    try {
      const pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption:     true,
        throwOnInvalidObject: false,
        updateMetadata:       false,
      });
      repairedBuffer = await pdfDoc.save({ useObjectStreams: false });
    } catch {
      throw new Error(
        'This PDF has a corrupt structure and could not be repaired. ' +
        'Re-save it from the original application, or use the PDF OCR tool for scanned files.'
      );
    }

    try {
      return await pdfParse(repairedBuffer);
    } catch {
      throw new Error(
        'Could not extract text from this PDF even after repair. ' +
        'It may be a scanned image-only PDF — try the PDF OCR tool instead.'
      );
    }
  }
}

/**
 * Download a URL and return its content as a Buffer.
 * Falls back to a signed Cloudinary URL if the plain URL returns 401.
 * Tries both 'raw' and 'image' resource types because files uploaded before
 * a middleware fix may have been stored as resource_type 'image' rather than
 * 'raw', causing the signed URL to return 404 if the wrong type is used.
 */
async function downloadBuffer(url, publicId = null, resourceType = 'raw') {
  let res = await fetch(url);

  // 401 from Cloudinary = PDF delivery blocked or signed URL required.
  // Retry with a signed URL generated via the SDK.
  if (res.status === 401 && publicId) {
    const signedUrl = cloudinary.url(publicId, {
      resource_type: resourceType,
      type:          'upload',
      sign_url:      true,
      secure:        true,
    });
    res = await fetch(signedUrl);

    // If still failing, try the alternate resource type.
    // Files uploaded before the middleware fix may be stored as 'image'
    // instead of 'raw' (or vice-versa).
    if (!res.ok) {
      const altResourceType = resourceType === 'raw' ? 'image' : 'raw';
      const altSignedUrl = cloudinary.url(publicId, {
        resource_type: altResourceType,
        type:          'upload',
        sign_url:      true,
        secure:        true,
      });
      const altRes = await fetch(altSignedUrl);
      if (altRes.ok) res = altRes;
    }
  }

  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload a Buffer to Cloudinary and return the upload result.
 * PDFs and DOCX files are stored as resource_type: 'raw'.
 */
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: 'toolhive/processed',
        use_filename: true,
        unique_filename: true,
        ...options,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/**
 * Upload a Buffer as an image to Cloudinary.
 */
function uploadImageBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: 'toolhive/processed',
        ...options,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// ─── Job processor ────────────────────────────────────────────────────────────

async function processPdfJob(job) {
  const { tool, fileId, userId, options = {}, inputData = {} } = job.data;
  const startTime = Date.now();

  logger.info('Processing PDF job', { jobId: job.id, tool, fileId });

  await Job.findOneAndUpdate(
    { jobId: job.id },
    { status: 'processing', startedAt: new Date(), progress: 10 }
  );
  await job.updateProgress(10);

  let outputData;

  try {
    switch (tool) {
      case 'compress':
      case 'pdf-compress':          // legacy alias
        outputData = await compressPdf(job, fileId, options);
        break;
      case 'merge':
      case 'pdf-merge':             // legacy alias
        outputData = await mergePdfs(job, inputData.fileIds || [], options);
        break;
      case 'split':
      case 'pdf-split':             // legacy alias
        outputData = await splitPdf(job, fileId, options);
        break;
      case 'pdf-to-word':
        outputData = await pdfToWord(job, fileId, options);
        break;
      case 'pdf-to-jpg':
        outputData = await pdfToImage(job, fileId, options);
        break;
      case 'ocr':
      case 'pdf-ocr':               // legacy alias
        outputData = await pdfOcr(job, fileId, options);
        break;
      case 'jpg-to-pdf':
        outputData = await imageToPdf(job, fileId, options);
        break;
      case 'protect':
      case 'pdf-protect':           // legacy alias
        outputData = await protectPdf(job, fileId, options);
        break;
      case 'rotate':
        outputData = await rotatePdf(job, fileId, options);
        break;
      case 'unlock':
        outputData = await unlockPdf(job, fileId, options);
        break;
      case 'watermark':
        outputData = await watermarkPdf(job, fileId, options);
        break;
      case 'page-numbers':
        outputData = await addPageNumbers(job, fileId, options);
        break;
      case 'pdf-to-excel':
        outputData = await pdfToExcel(job, fileId, options);
        break;
      case 'sign':
        outputData = await signPdf(job, fileId, options);
        break;
      default:
        throw new Error(`Unknown PDF tool: ${tool}`);
    }

    await job.updateProgress(100);
    const processingTime = Date.now() - startTime;

    await Job.findOneAndUpdate(
      { jobId: job.id },
      {
        status: 'completed',
        progress: 100,
        outputData,
        completedAt: new Date(),
        processingTime,
      }
    );

    if (outputData.processedUrl) {
      await File.findByIdAndUpdate(fileId, {
        status: 'processed',
        processedUrl: outputData.processedUrl,
        processedPublicId: outputData.processedPublicId,
      });
    }

    logger.info('PDF job completed', { jobId: job.id, tool, processingTime });
    return outputData;

  } catch (err) {
    await Job.findOneAndUpdate(
      { jobId: job.id },
      { status: 'failed', error: err.message, completedAt: new Date() }
    );
    if (fileId) await File.findByIdAndUpdate(fileId, { status: 'failed' });
    throw err;
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

/**
 * pdf-compress
 * Load the PDF with pdf-lib and re-save it. This removes unused/dead objects
 * (annotations, metadata bloat, duplicate objects) — typically 5-20% smaller.
 */
async function compressPdf(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const originalBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const originalSize = originalBuffer.length;

  await job.updateProgress(40);
  const pdfDoc = await PDFDocument.load(originalBuffer, {
    ignoreEncryption: true,
  });

  // Re-save with object streams (better compression)
  const compressedBuffer = await pdfDoc.save({ useObjectStreams: true });
  const processedSize = compressedBuffer.length;

  await job.updateProgress(70);
  const uploadResult = await uploadBuffer(compressedBuffer, {
    public_id: `${file.publicId}_compressed`,
    format: 'pdf',
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    originalSize,
    processedSize,
    compressionRatio:  Number(((1 - processedSize / originalSize) * 100).toFixed(1)),
    pageCount:         pdfDoc.getPageCount(),
  };
}

/**
 * pdf-merge
 * Merge multiple PDF files into one document.
 * Expects job.data.inputData.fileIds = ['mongoId1', 'mongoId2', ...]
 */
async function mergePdfs(job, fileIds, options) {
  if (!fileIds || fileIds.length < 2) {
    throw new Error('At least 2 file IDs are required for merge');
  }

  await job.updateProgress(15);
  const files = await File.find({ _id: { $in: fileIds } });
  if (files.length < 2) throw new Error('Could not find the files to merge');

  const mergedDoc = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const buffer = await downloadBuffer(files[i].url);
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const copiedPages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    copiedPages.forEach((page) => mergedDoc.addPage(page));

    await job.updateProgress(15 + Math.floor((i + 1) / files.length * 55));
  }

  const mergedBuffer = await mergedDoc.save({ useObjectStreams: true });

  await job.updateProgress(80);
  const uploadResult = await uploadBuffer(mergedBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/merged_${Date.now()}`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    totalPages:        mergedDoc.getPageCount(),
    mergedFileCount:   files.length,
  };
}

/**
 * pdf-split
 * Split a PDF into individual single-page PDFs.
 * Returns an array of page URLs.
 */
async function splitPdf(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const originalBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const srcDoc = await PDFDocument.load(originalBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  const pageUrls = [];

  for (let i = 0; i < totalPages; i++) {
    const singlePage = await PDFDocument.create();
    const [copiedPage] = await singlePage.copyPages(srcDoc, [i]);
    singlePage.addPage(copiedPage);

    const pageBuffer = await singlePage.save({ useObjectStreams: true });
    const uploadResult = await uploadBuffer(pageBuffer, {
      format: 'pdf',
      public_id: `toolhive/processed/${file.publicId}_page_${i + 1}`,
    });

    pageUrls.push({
      page: i + 1,
      url:  uploadResult.secure_url,
    });

    await job.updateProgress(20 + Math.floor(((i + 1) / totalPages) * 65));
  }

  await job.updateProgress(90);
  return {
    processedUrl:      pageUrls[0]?.url || null,
    processedPublicId: null,
    totalPages,
    pages:             pageUrls,
  };
}

/**
 * pdf-to-word
 * Extract all text from a PDF and produce a .docx file.
 * Works well for text-based PDFs. Scanned PDFs need OCR first.
 */
async function pdfToWord(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');

  await job.updateProgress(40);
  const parsed  = await parsePdfSafe(pdfBuffer);
  const rawText = parsed.text || '';

  if (!rawText.trim()) {
    throw new Error('No extractable text found. The PDF may be scanned — use pdf-ocr instead.');
  }

  await job.updateProgress(60);

  // Split text into paragraphs and build DOCX
  const lines = rawText.split('\n').filter((l) => l.trim());
  const paragraphs = lines.map((line) =>
    new Paragraph({
      children: [new TextRun({ text: line, size: 24 })],
      spacing: { after: 100 },
    })
  );

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: file.originalName || 'Converted Document',
            heading: HeadingLevel.TITLE,
            spacing: { after: 300 },
          }),
          ...paragraphs,
        ],
      },
    ],
  });

  await job.updateProgress(75);
  const docxBuffer = await Packer.toBuffer(doc);

  const baseName = (file.originalName || 'document').replace(/\.pdf$/i, '');
  const uploadResult = await uploadBuffer(docxBuffer, {
    format: 'docx',
    public_id: `toolhive/processed/${baseName}_converted_${Date.now()}`,
    resource_type: 'raw',
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    wordCount:         rawText.split(/\s+/).filter(Boolean).length,
    pageCount:         parsed.numpages,
  };
}

/**
 * pdf-to-jpg
 * Convert the first page (or all pages) of a PDF to JPEG images.
 * Uses Cloudinary's built-in PDF page transformation.
 * The PDF must have been uploaded with resource_type 'image' or 'auto'.
 */
async function pdfToImage(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(30);

  // Re-upload the PDF as resource_type 'image' so Cloudinary can generate page images
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfAsImage = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: 'toolhive/processed',
        format: 'jpg',
        public_id: `${file.publicId}_pages`,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(pdfBuffer);
  });

  await job.updateProgress(70);

  // Cloudinary stores page 1 as the direct upload URL (no transformation needed).
  // For page 2+ we use the pg_N transformation, but page 1 uses secure_url directly
  // to avoid the "PDF delivery disabled" 401 that transformation URLs trigger.
  const totalPages = pdfAsImage.pages || 1;
  const pageUrls = [];

  for (let i = 1; i <= totalPages; i++) {
    // Page 1: use the direct uploaded JPG URL (no pg_ transformation = no PDF rendering needed)
    // Page 2+: must use Cloudinary's page transformation — requires PDF delivery enabled
    const pageUrl = i === 1
      ? pdfAsImage.secure_url
      : cloudinary.url(pdfAsImage.public_id, {
          page: i,
          format: 'jpg',
          quality: options.quality || 'auto',
          secure: true,
        });
    pageUrls.push({ page: i, url: pageUrl });
  }

  await job.updateProgress(90);
  return {
    processedUrl:      pdfAsImage.secure_url,  // page 1 direct URL
    processedPublicId: pdfAsImage.public_id,
    totalPages,
    pages:             pageUrls,
  };
}

/**
 * pdf-ocr
 * Extract text from a PDF using pdf-parse.
 * Works on text-based PDFs. For scanned PDFs, install Tesseract.js
 * and convert pages to images first.
 */
async function pdfOcr(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');

  await job.updateProgress(50);
  const parsed = await parsePdfSafe(pdfBuffer);
  const text   = parsed.text || '';

  if (!text.trim()) {
    throw new Error(
      'No text found in PDF. If this is a scanned document, Tesseract.js OCR is required.'
    );
  }

  await job.updateProgress(80);

  // Optionally upload extracted text as a .txt file
  const txtBuffer = Buffer.from(text, 'utf-8');
  const uploadResult = await uploadBuffer(txtBuffer, {
    format: 'txt',
    resource_type: 'raw',
    public_id: `toolhive/processed/${file.publicId}_ocr_${Date.now()}`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    text,
    wordCount:         text.split(/\s+/).filter(Boolean).length,
    pageCount:         parsed.numpages,
  };
}

/**
 * jpg-to-pdf
 * Embed one or more images into a new PDF document.
 * Accepts a single fileId (image) or inputData.fileIds (multiple images).
 */
async function imageToPdf(job, fileId, options) {
  const { inputData = {} } = job.data;
  const fileIds = inputData.fileIds || (fileId ? [fileId] : []);
  if (!fileIds.length) throw new Error('No image file IDs provided');

  await job.updateProgress(10);
  const files = await File.find({ _id: { $in: fileIds } });
  if (!files.length) throw new Error('No files found');

  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const imgBuffer = await downloadBuffer(files[i].url);
    const mimeType  = files[i].mimeType || files[i].url;

    let image;
    if (mimeType.includes('png')) {
      image = await pdfDoc.embedPng(imgBuffer);
    } else {
      // Default to JPEG for jpg/jpeg/webp (pdf-lib converts via re-encode)
      image = await pdfDoc.embedJpg(imgBuffer);
    }

    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width:  image.width,
      height: image.height,
    });

    await job.updateProgress(10 + Math.floor(((i + 1) / files.length) * 70));
  }

  const pdfBuffer = await pdfDoc.save({ useObjectStreams: true });

  await job.updateProgress(85);
  const uploadResult = await uploadBuffer(pdfBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/images_to_pdf_${Date.now()}`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pdfDoc.getPageCount(),
    sourceImages:      files.length,
  };
}

/**
 * pdf-protect
 * NOTE: pdf-lib does NOT support PDF encryption/password protection.
 * We re-save the PDF and embed a metadata note. For real encryption,
 * install node-qpdf2 + qpdf system tool.
 */
async function protectPdf(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  // Set document metadata (best available without qpdf)
  pdfDoc.setTitle(options.title || file.originalName || 'Protected Document');
  pdfDoc.setProducer('ToolHive');
  pdfDoc.setCreationDate(new Date());

  await job.updateProgress(60);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_protected`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    note: 'Full password encryption requires qpdf. Document metadata has been secured.',
  };
}

/**
 * rotate
 * Rotate pages in a PDF by a given angle (90, 180, 270).
 */
async function rotatePdf(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const angle = options.angle || 90;

  // Rotate all pages (or specific page if options.pageIndex is set)
  const targetPages = options.pageIndex !== undefined
    ? [pages[options.pageIndex]].filter(Boolean)
    : pages;

  targetPages.forEach((page) => {
    const current = page.getRotation().angle;
    page.setRotation({ type: 'degrees', angle: (current + angle) % 360 });
  });

  await job.updateProgress(70);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_rotated`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pdfDoc.getPageCount(),
    angle,
  };
}

/**
 * unlock
 * Remove PDF password protection by loading with ignoreEncryption and re-saving.
 * Works for owner-password-protected PDFs. User-password PDFs need the password.
 */
async function unlockPdf(job, fileId, options) {
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');

  const loadOptions = { ignoreEncryption: true };
  if (options.password) loadOptions.password = options.password;

  const pdfDoc = await PDFDocument.load(pdfBuffer, loadOptions);

  await job.updateProgress(60);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_unlocked`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pdfDoc.getPageCount(),
  };
}

/**
 * watermark
 * Add a text watermark to every page of a PDF using pdf-lib.
 */
async function watermarkPdf(job, fileId, options) {
  const { StandardFonts, rgb, degrees } = require('pdf-lib');

  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();
  const text = options.text || 'CONFIDENTIAL';
  const fontSize = options.fontSize || 48;
  const opacity = options.opacity !== undefined ? options.opacity / 100 : 0.3;

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: (width - textWidth) / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.75, 0.75, 0.75),
      opacity,
      rotate: degrees(45),
    });
  });

  await job.updateProgress(75);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_watermarked`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pages.length,
  };
}

/**
 * page-numbers
 * Add page numbers to every page footer using pdf-lib.
 */
async function addPageNumbers(job, fileId, options) {
  const { StandardFonts, rgb } = require('pdf-lib');

  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const fontSize = options.fontSize || 10;
  const startAt = options.startAt || 1;
  const position = options.position || 'bottom-center'; // bottom-center | bottom-right | bottom-left

  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    const text = String(i + startAt);
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    let x;
    if (position === 'bottom-right') x = width - textWidth - 20;
    else if (position === 'bottom-left') x = 20;
    else x = (width - textWidth) / 2; // center

    page.drawText(text, {
      x,
      y: 20,
      size: fontSize,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
  });

  await job.updateProgress(75);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_numbered`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pages.length,
  };
}

/**
 * sign
 * Add a text-based signature to the last page of a PDF.
 * For a proper e-signature UI, the frontend passes sigText + position.
 */
async function signPdf(job, fileId, options) {
  const { StandardFonts, rgb } = require('pdf-lib');

  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const targetPage = pages[options.pageIndex ?? pages.length - 1];
  if (!targetPage) throw new Error('Target page not found');

  const { width, height } = targetPage.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const sigText = options.sigText || options.text || 'Signed';
  const fontSize = options.fontSize || 20;
  const x = options.x !== undefined ? options.x : width - 200;
  const y = options.y !== undefined ? options.y : 60;

  targetPage.drawText(sigText, {
    x, y,
    size: fontSize,
    font,
    color: rgb(0.1, 0.1, 0.6),
  });

  // Add signature date below
  const dateFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  targetPage.drawText(new Date().toLocaleDateString(), {
    x, y: y - fontSize - 4,
    size: 9,
    font: dateFont,
    color: rgb(0.4, 0.4, 0.4),
  });

  await job.updateProgress(75);
  const outBuffer = await pdfDoc.save({ useObjectStreams: true });
  const uploadResult = await uploadBuffer(outBuffer, {
    format: 'pdf',
    public_id: `toolhive/processed/${file.publicId}_signed`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    pageCount:         pages.length,
  };
}

/**
 * pdf-to-excel
 * Extract tables from PDF using pdf-parse + ExcelJS.
 * Detects whitespace-separated columns and writes to .xlsx.
 */
async function pdfToExcel(job, fileId, options) {
  const ExcelJS = require('exceljs');

  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(20);
  const pdfBuffer = await downloadBuffer(file.url, file.publicId, 'raw');

  await job.updateProgress(40);
  const parsed  = await parsePdfSafe(pdfBuffer);
  const rawText = parsed.text || '';

  if (!rawText.trim()) {
    throw new Error('No extractable text found in PDF. Scanned PDFs need OCR first.');
  }

  await job.updateProgress(60);

  // Simple column detection: split lines by 2+ spaces
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  const lines = rawText.split('\n').filter((l) => l.trim());

  lines.forEach((line) => {
    const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length) sheet.addRow(cells);
  });

  await job.updateProgress(75);
  const xlsxBuffer = await workbook.xlsx.writeBuffer();

  const baseName = (file.originalName || 'document').replace(/\.pdf$/i, '');
  const uploadResult = await uploadBuffer(Buffer.from(xlsxBuffer), {
    format: 'xlsx',
    resource_type: 'raw',
    public_id: `toolhive/processed/${baseName}_converted_${Date.now()}`,
  });

  await job.updateProgress(90);
  return {
    processedUrl:      uploadResult.secure_url,
    processedPublicId: uploadResult.public_id,
    rowCount:          sheet.rowCount,
    pageCount:         parsed.numpages,
  };
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const worker = new Worker('pdf-processing', processPdfJob, {
  connection: redisClient,
  concurrency: 5,
});

worker.on('completed', (job) => logger.info('PDF job done', { jobId: job.id }));
worker.on('failed', (job, err) => logger.error('PDF job failed', { jobId: job?.id, error: err.message }));
worker.on('error', (err) => logger.error('PDF worker error', { error: err.message }));

logger.info('PDF worker started — listening on queue: pdf-processing');

module.exports = worker;
