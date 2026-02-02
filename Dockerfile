FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app files
COPY . .

# Expose port 7860 (Hugging Face default)
EXPOSE 7860

# Set port for HF
ENV PORT=7860

# Run the app
CMD ["node", "server.cjs"]