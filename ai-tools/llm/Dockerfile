FROM nvidia/cuda:12.5.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    python3 \
    python3-pip \
    curl \
    pciutils \
    libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

#RUN git clone https://github.com/ggml-org/llama.cpp.git
RUN git clone -b mtp-clean https://github.com/am17an/llama.cpp.git

RUN cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_CUDA=ON \
    -DLLAMA_CUDA=ON \
    -DGGML_CUDA_F16=ON \
    -DLLAMA_CUDA_FMHA=ON \
    -DLLAMA_CURL=ON \
    -DCMAKE_CUDA_ARCHITECTURES=89 \
    -DCMAKE_BUILD_TYPE=Release

RUN cmake --build llama.cpp/build --config Release -j2 --clean-first --target llama-cli llama-server

EXPOSE 8080

CMD ["bash"]