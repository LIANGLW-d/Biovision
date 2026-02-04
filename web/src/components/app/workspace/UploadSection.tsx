"use client";

import { useCallback, useRef } from "react";
import { Upload, FileArchive, Image, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface UploadSectionProps {
  files: File[];
  s3Path: string;
  onUpload: (files: File[]) => void;
  onS3PathChange: (value: string) => void;
}

const UploadSection = ({ files, s3Path, onUpload, onS3PathChange }: UploadSectionProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const droppedFiles = Array.from(e.dataTransfer.files);
      onUpload(droppedFiles);
    },
    [onUpload]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onUpload(Array.from(e.target.files));
      onS3PathChange("");
    }
  };

  const imageCount = files.filter((f) => f.type.startsWith("image/")).length;
  const zipCount = files.filter((f) => f.name.endsWith(".zip")).length;

  return (
    <div className="glass-panel p-6">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Upload className="w-5 h-5 text-primary" />
        Upload Images
      </h3>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,.zip"
          onChange={handleFileChange}
          className="hidden"
        />
        <div className="flex justify-center gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <Image className="w-6 h-6" />
          </div>
          <div className="w-12 h-12 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center">
            <FileArchive className="w-6 h-6" />
          </div>
        </div>
        <p className="text-foreground font-medium mb-1">
          Drop images or ZIP files here
        </p>
        <p className="text-sm text-muted-foreground">
          or click to browse your files
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-ghost border border-border"
            onClick={() => inputRef.current?.click()}
          >
            Upload files
          </button>
          <button
            type="button"
            className="btn-ghost border border-border"
            onClick={() => folderInputRef.current?.click()}
          >
            Upload folder
          </button>
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Or use S3 path</label>
          <input
            value={s3Path}
            onChange={(e) => onS3PathChange(e.target.value)}
            placeholder="s3://bucket/prefix-or-object"
            className="input-dark w-full"
          />
          <p className="text-xs text-muted-foreground mt-2">
            If S3 path is set, local uploads are ignored.
          </p>
        </div>
      </div>
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)}
        onChange={handleFileChange}
        className="hidden"
      />

      <AnimatePresence>
        {files.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-4 p-4 bg-muted/30 rounded-xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {imageCount > 0 && (
                  <span className="flex items-center gap-2 text-sm">
                    <Image className="w-4 h-4 text-primary" />
                    <span className="font-mono">{imageCount}</span> images
                  </span>
                )}
                {zipCount > 0 && (
                  <span className="flex items-center gap-2 text-sm">
                    <FileArchive className="w-4 h-4 text-secondary" />
                    <span className="font-mono">{zipCount}</span> ZIP file(s)
                  </span>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUpload([]);
                }}
                className="p-1 hover:bg-muted rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default UploadSection;
