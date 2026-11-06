"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Standard page column with a short, subtle entrance. Reduced motion is respected via MotionConfig. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn("mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 sm:py-12", className)}
    >
      {children}
    </motion.div>
  );
}
