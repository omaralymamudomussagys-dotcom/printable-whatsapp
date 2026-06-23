FROM node:18-alpine

# Instalar dependências necessárias para algumas libs nativas (se existirem)
RUN apk add --no-cache git python3 make g++ 

WORKDIR /app

# Copiar ficheiros de dependências
COPY package*.json ./

# Instalar dependências (apenas as de produção)
RUN npm install --production

# Copiar o restante código
COPY . .

# Expor a porta
EXPOSE 3000

# Criar o volume para as sessões, assim os dados de login não se perdem
VOLUME ["/app/sessions"]

# Comando de arranque
CMD ["npm", "start"]
