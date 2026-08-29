import { cn } from "@/lib/utils"; // ✅ استفاده از الیاس جدید

export function GridBackground({ children, alignItems }) {
  return (
    <div 
      className="h-full w-full bg-primaryDark bg-grid-white/[0.2] relative flex justify-center flex-col" 
      style={{ alignItems: alignItems ?? 'center' }}
    >
      {/* ماسک برای فید شدن در کناره‌ها */}
      <div className="absolute pointer-events-none inset-0 flex items-center justify-center bg-primaryDark [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]"></div>
      
      {/* محتوا */}
      <div className="relative z-20">
        {children}
      </div>
    </div>
  );
}

export function DotBackground({ children, justifyContent = 'center' }) {
  return (
    <div 
      className="w-full bg-bgBase relative flex flex-1 items-center flex-col transition-colors duration-300" 
      style={{ justifyContent }}
    >
      <div
        className={cn(
          "absolute inset-0",
          "[background-size:20px_20px]",
          "[background-image:radial-gradient(var(--color-border)_1px,transparent_1px)]"
        )}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bgBase [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)] transition-colors duration-300"/>
      {children}
    </div>
  );
}