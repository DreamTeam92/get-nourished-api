import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

dotenv.config();

const filePath = process.argv[2];
const objectKey = process.argv[3];

if (!filePath || !objectKey) {
  console.error(
    "Usage: node upload-ebook.js <local-file-path> <r2-object-key>",
  );
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const fileSize = fs.statSync(filePath).size;

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucket = process.env.R2_BUCKET_NAME;

if (!bucket) {
  console.error("R2_BUCKET_NAME is not configured.");
  process.exit(1);
}

console.log("🚀 Starting R2 ebook upload...");
console.log(`📚 File: ${path.basename(filePath)}`);
console.log(`📦 Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`🗂️ Bucket: ${bucket}`);
console.log(`🔑 Object: ${objectKey}`);

try {
  const upload = new Upload({
    client: r2Client,
    params: {
      Bucket: bucket,
      Key: objectKey,
      Body: fs.createReadStream(filePath),
      ContentType: "application/pdf",
    },
    partSize: 10 * 1024 * 1024,
    queueSize: 4,
  });

  upload.on("httpUploadProgress", (progress) => {
    if (progress.loaded && fileSize) {
      const percent = ((progress.loaded / fileSize) * 100).toFixed(1);
      process.stdout.write(`\r📤 Upload progress: ${percent}%`);
    }
  });

  await upload.done();

  console.log("\n✅ Ebook uploaded successfully!");
  console.log(`🔐 Private R2 object: ${objectKey}`);
} catch (error) {
  console.error("\n❌ Ebook upload failed.");
  console.error(error);
  process.exit(1);
}
