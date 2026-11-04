import * as echarts from 'echarts/core';
import { BarChart, LineChart, ParallelChart, ScatterChart, CustomChart } from 'echarts/charts';
import {
  BrushComponent, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  ParallelComponent, TitleComponent, TooltipComponent, VisualMapComponent, AxisPointerComponent, GraphicComponent, ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart, LineChart, ParallelChart, ScatterChart, CustomChart,
  BrushComponent, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  ParallelComponent, TitleComponent, TooltipComponent, VisualMapComponent, AxisPointerComponent, GraphicComponent, ToolboxComponent,
  CanvasRenderer, SVGRenderer,
]);

export { echarts };
export type { EChartsCoreOption as Option } from 'echarts/core';
