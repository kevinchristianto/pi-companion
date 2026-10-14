import type { SVGProps } from 'react';

// Repo-native integer-grid icons keep every control consistent with the pixel frame.
const PixelIcon = ({ children, ...props }: SVGProps<SVGSVGElement>) => <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" {...props}>{children}</svg>;
export const CheckIcon = (props: SVGProps<SVGSVGElement>) => <PixelIcon {...props}><path d="M2 7h2v2h2v2h2V9h2V7h2V5h2V3h-2v2h-2v2H8v2H6V7H4V5H2z" /></PixelIcon>;
export const ChevronRightIcon = (props: SVGProps<SVGSVGElement>) => <PixelIcon {...props}><path d="M5 2h2v2h2v2h2v4H9v2H7v2H5v-2h2v-2h2V6H7V4H5z" /></PixelIcon>;
export const RadioIcon = (props: SVGProps<SVGSVGElement>) => <PixelIcon {...props}><path d="M3 3h10v10H3z" /></PixelIcon>;
export const CloseIcon = (props: SVGProps<SVGSVGElement>) => <PixelIcon {...props}><path d="M2 2h2v2h2v2h4V4h2V2h2v2h-2v2h-2v4h2v2h2v2h-2v-2h-2v-2H6v2H4v2H2v-2h2v-2h2V6H4V4H2z" /></PixelIcon>;
