import * as React from "react";
import { cn } from "@/lib/utils";

interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onValueChange?: (value: number) => void;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, onValueChange, onChange, ...props }, ref) => {
    return (
      <input
        type="range"
        ref={ref}
        className={cn("slider-input w-full", className)}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(parseFloat(e.target.value));
        }}
        {...props}
      />
    );
  }
);
Slider.displayName = "Slider";

export { Slider };
