import { BookOpenText, Gauge, List, Network, ScatterChart, type LucideIcon } from 'lucide-react';
import type { PanelId } from './workspace';

export const PANEL_ICON: Record<PanelId, LucideIcon> = { runs: List, designs: ScatterChart, arch: Network, perf: Gauge, model: BookOpenText };
