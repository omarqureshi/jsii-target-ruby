// The TypeScript twin of app.rb. Keep the two in step: the conformance check
// is only meaningful while they build the same chart.
import { App, Chart } from 'cdk8s';
import { Deployment } from 'cdk8s-plus-27';

const app = new App();
const chart = new Chart(app, 'hello');
new Deployment(chart, 'web', {
  replicas: 2,
  containers: [{ image: 'nginx:1.27', port: 80 }],
});
app.synth();
