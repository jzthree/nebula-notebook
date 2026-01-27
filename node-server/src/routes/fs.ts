/**
 * Filesystem API Routes
 */

import { Router, Request, Response } from 'express';
import { FilesystemService } from '../fs/fs-service';
import multer from 'multer';
import * as path from 'path';
import * as os from 'os';

const router = Router();
const fsService = new FilesystemService();

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      cb(null, `upload-${Date.now()}-${file.originalname}`);
    },
  }),
});

/**
 * List directory contents
 */
router.get('/fs/list', (req: Request, res: Response) => {
  try {
    const dirPath = (req.query.path as string) || '~';
    const result = fsService.listDirectory(dirPath);
    res.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        res.status(404).json({ detail: err.message });
      } else if (err.message.includes('permission') || err.message.includes('EACCES')) {
        res.status(403).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Get directory modification time
 */
router.get('/fs/mtime', (req: Request, res: Response) => {
  try {
    const dirPath = (req.query.path as string) || '~';
    const result = fsService.getDirectoryMtime(dirPath);
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ detail: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
  }
});

/**
 * Get file modification time
 */
router.get('/fs/file-mtime', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }
    const result = fsService.getFileMtime(filePath);
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ detail: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
  }
});

/**
 * Read file contents
 */
router.get('/fs/read', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }
    const result = fsService.readFile(filePath);
    res.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        res.status(404).json({ detail: err.message });
      } else if (err.message.includes('directory') || err.message.includes('EISDIR')) {
        res.status(400).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Write content to a file
 */
router.post('/fs/write', (req: Request, res: Response) => {
  try {
    const { path: filePath, content, file_type = 'text' } = req.body;
    if (!filePath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }
    fsService.writeFile(filePath, content, file_type);
    res.json({ status: 'ok', path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Create a new file or directory
 */
router.post('/fs/create', (req: Request, res: Response) => {
  try {
    const { path: filePath, is_directory = false } = req.body;
    if (!filePath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }
    const info = fsService.createFile(filePath, is_directory);
    res.json({ status: 'ok', file: info });
  } catch (err) {
    if (err instanceof Error && err.message.includes('exists')) {
      res.status(409).json({ detail: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
  }
});

/**
 * Delete a file or directory
 */
router.delete('/fs/delete', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }
    fsService.deleteFile(filePath);
    res.json({ status: 'ok' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ detail: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
  }
});

/**
 * Rename/move a file or directory
 */
router.post('/fs/rename', (req: Request, res: Response) => {
  try {
    const { old_path, new_path } = req.body;
    if (!old_path || !new_path) {
      res.status(400).json({ detail: 'old_path and new_path are required' });
      return;
    }
    const info = fsService.renameFile(old_path, new_path);
    res.json({ status: 'ok', file: info });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found')) {
        res.status(404).json({ detail: err.message });
      } else if (err.message.includes('exists')) {
        res.status(409).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Duplicate a file
 */
router.post('/fs/duplicate', (req: Request, res: Response) => {
  try {
    const { path: filePath } = req.body;
    if (!filePath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }
    const info = fsService.duplicateFile(filePath);
    res.json({ status: 'ok', file: info });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found')) {
        res.status(404).json({ detail: err.message });
      } else if (err.message.includes('directory')) {
        res.status(400).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Download a file (raw stream with proper headers)
 */
router.get('/fs/download', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }

    const normalizedPath = fsService.normalizePath(filePath);
    const fs = require('fs');
    const pathModule = require('path');

    if (!fs.existsSync(normalizedPath)) {
      res.status(404).json({ detail: `File not found: ${normalizedPath}` });
      return;
    }

    const stat = fs.statSync(normalizedPath);
    if (stat.isDirectory()) {
      res.status(400).json({ detail: 'Cannot download a directory' });
      return;
    }

    const filename = pathModule.basename(normalizedPath);
    const extension = pathModule.extname(normalizedPath).toLowerCase();

    // Set content type based on extension
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.ipynb': 'application/json',
      '.py': 'text/x-python',
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };

    const contentType = mimeTypes[extension] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(normalizedPath);
    stream.pipe(res);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        res.status(404).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Upload a file
 */
router.post('/fs/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const destPath = req.body.path;
    const file = req.file;

    if (!destPath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }
    if (!file) {
      res.status(400).json({ detail: 'file is required' });
      return;
    }

    const info = await fsService.uploadFile(destPath, file.path, file.originalname);
    res.json({ status: 'ok', file: info });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found')) {
        res.status(404).json({ detail: err.message });
      } else if (err.message.includes('permission')) {
        res.status(403).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

export { fsService };
export default router;
