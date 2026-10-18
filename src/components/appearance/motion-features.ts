// Loaded lazily by <LazyMotion features={...}> so Motion's animation + layout engine is not in
// every route's first-load JS; `m.*` components render static until it arrives (~once per session).
import { domMax } from "motion/react";

export default domMax;
