import { Chart, LineController, ScatterController, LineElement, PointElement, LinearScale, Tooltip, Filler } from 'chart.js';

// These views only use numeric time axes, lines and scatter points. Avoid
// shipping every Chart.js controller and scale to the extension popup.
Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, Tooltip, Filler);
export default Chart;
