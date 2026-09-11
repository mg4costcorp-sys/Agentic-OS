import {createRoot} from 'react-dom/client';
import {SitePalette, type PaletteProps} from '@/components/ui/site-palette';
import {Monitor, Tablet, Smartphone, RotateCw, Maximize2, Minimize2, SlidersHorizontal, WandSparkles, Upload, RotateCcw, ArrowUpRight, Search, Check, FileText, Image, Play, X, ChevronRight} from 'lucide-react';
export function mountPalette(element: HTMLElement, props: PaletteProps) {
  const root = createRoot(element);
  root.render(<SitePalette {...props}/>);
  return () => root.unmount();
}
const icons = {Monitor, Tablet, Smartphone, RotateCw, Maximize2, Minimize2, SlidersHorizontal, WandSparkles, Upload, RotateCcw, ArrowUpRight, Search, Check, FileText, Image, Play, X, ChevronRight};
export function mountIcons(container: HTMLElement = document.body) {
  container.querySelectorAll<HTMLElement>('[data-icon]:empty').forEach(element => {
    const Icon = icons[element.dataset.icon as keyof typeof icons];
    if (Icon) createRoot(element).render(<Icon size={14} strokeWidth={1.6} aria-hidden="true"/>);
  });
}
