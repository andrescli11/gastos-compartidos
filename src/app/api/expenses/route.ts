import { route } from '@/server/route-handler';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(request:Request){return route(request,'list');}
export function POST(request:Request){return route(request,'mutate');}
