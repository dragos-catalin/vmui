ARG BUILD_FROM=ghcr.io/dragos-catalin/vatra:0.4.0
FROM ${BUILD_FROM}
USER root
COPY run.sh /run.sh
RUN chmod 0755 /run.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/run.sh"]
CMD []
