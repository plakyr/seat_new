/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useSocket } from './store/useSocket';
import Home from './pages/Home';
import Admin from './pages/Admin';
import User from './pages/User';
import ToastContainer from './components/ToastContainer';

export default function App() {
  // Initialize socket connection
  useSocket();

  return (
    <BrowserRouter>
      <ToastContainer />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin/*" element={<Admin />} />
        <Route path="/user/*" element={<User />} />
      </Routes>
    </BrowserRouter>
  );
}
