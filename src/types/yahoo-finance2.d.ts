declare module 'yahoo-finance2' {
  const yahooFinance: {
    historical(symbol: string, options: any): Promise<any>;
    // Add other methods as needed
  };
  export default yahooFinance;
}
