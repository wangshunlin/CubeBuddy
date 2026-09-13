FROM nginx:1.27-alpine
ARG BUILD_REVISION=development
ARG BUILD_CREATED=unknown
LABEL org.opencontainers.image.revision=$BUILD_REVISION \
      org.opencontainers.image.created=$BUILD_CREATED
COPY nginx.conf /etc/nginx/nginx.conf
COPY proxy_params /etc/nginx/proxy_params
EXPOSE 80 81
