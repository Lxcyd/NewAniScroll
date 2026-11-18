import type { SVGProps } from "react";

/* LE cœur des favoris (choisi par Luc le 15/11/2026). Le tracé occupe
   x 2→22, y 2,65→20,33 : la boîte `2 1.49 20 20` le centre sur son milieu
   (11,49), sinon il penche vers le bas dans sa boîte. */
export const HEART_PATH =
  "M11.29,20.2q-0.36-0.13-0.64-0.4L8.93,18.23Q6.28,15.8 4.14,13.41Q2,11.02 2,8.15Q2,5.8 3.58,4.22T7.5,2.65q1.33,0 2.5,0.56t2,1.54q0.83-0.98 2-1.54t2.5-0.56q2.35,0 3.93,1.57T22,8.15q0,2.88-2.13,5.28t-4.82,4.83l-1.7,1.55q-0.28,0.27-0.64,0.4T12,20.33T11.29,20.2Z";
export const HEART_VIEWBOX = "2 1.49 20 20";

export function HeartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={HEART_VIEWBOX} fill="currentColor" aria-hidden="true" {...props}>
      <path d={HEART_PATH} />
    </svg>
  );
}
