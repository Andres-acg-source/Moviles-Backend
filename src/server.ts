import { createApp } from './app.js';

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`ParkWise API listening on http://localhost:${port}`));