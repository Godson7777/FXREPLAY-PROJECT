export const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
