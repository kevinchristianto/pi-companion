import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

import {
  Dialog as ShadcnDialog,
  DialogClose as ShadcnDialogClose,
  DialogContent as ShadcnDialogContent,
  DialogDescription as ShadcnDialogDescription,
  DialogFooter as ShadcnDialogFooter,
  DialogHeader as ShadcnDialogHeader,
  DialogTitle as ShadcnDialogTitle,
  DialogTrigger as ShadcnDialogTrigger,
} from "@/components/ui/dialog";

import "@/components/ui/8bit/styles/retro.css";

const Dialog = ShadcnDialog;

const DialogTrigger = ShadcnDialogTrigger;

const DialogHeader = ShadcnDialogHeader;

const DialogDescription = ShadcnDialogDescription;

const DialogClose = ShadcnDialogClose;

const DialogFooter = ShadcnDialogFooter;

export interface BitDialogProps
  extends React.ComponentProps<typeof ShadcnDialogContent>,
    VariantProps<typeof dialogContentVariants> {}

function DialogTitle({ className, font, ...props }: React.ComponentProps<typeof ShadcnDialogTitle> & VariantProps<typeof dialogContentVariants>) {
  return (
    <ShadcnDialogTitle
      className={cn(font !== "normal" && "retro", className)}
      {...props}
    />
  );
}

export const dialogContentVariants = cva("", {
  variants: {
    font: {
      normal: "",
      retro: "retro",
    },
  },
  defaultVariants: {
    font: "retro",
  },
});

function DialogContent({
  className,
  children,
  font,
  ...props
}: BitDialogProps) {
  return (
    <ShadcnDialogContent
      className={cn(
        "bg-card rounded-none border-2 border-foreground",
        font !== "normal" && "retro",
        className
      )}
      {...props}
    >
      {children}
    </ShadcnDialogContent>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogHeader,
  DialogFooter,
  DialogDescription,
  DialogTitle,
  DialogContent,
  DialogClose,
};
